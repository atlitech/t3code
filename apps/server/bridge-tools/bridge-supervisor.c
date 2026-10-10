#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <limits.h>
#include <string.h>
#include <poll.h>
#include <sys/signalfd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* The supervisor owns just one namespace tree. A pidfd is acquired before
 * releasing exec; the subreaper drains every orphan before reporting exit. */


/* Kernel keyrings are inherited across namespaces and can expose custody keys
 * by serial number. Deny all key operations, including compat syscall paths. */
static int confine_keys(void) {
#if defined(__x86_64__)
  const unsigned int architecture = AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
  const unsigned int architecture = AUDIT_ARCH_AARCH64;
#else
  return -1;
#endif
  struct sock_filter filters[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, architecture, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000U, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_keyctl, 3, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_add_key, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_request_key, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
  };
  struct sock_fprog program = { .len = sizeof(filters) / sizeof(filters[0]), .filter = filters };
  return prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

/* A setup failure can orphan an init before its info record is delivered.
 * These PIDs are our own unreaped direct children, not names or stale records.
 * Retaining ownership until waitpid prevents reuse between enumeration/open. */
static int kill_adopted(void) {
  char path[80], children[65536];
  snprintf(path, sizeof(path), "/proc/self/task/%ld/children", (long)getpid());
  int record = open(path, O_RDONLY | O_CLOEXEC);
  if (record < 0) return -1;
  ssize_t size = read(record, children, sizeof(children) - 1);
  close(record);
  if (size < 0 || size == sizeof(children) - 1) return -1;
  children[size] = 0;
  char *next = children;
  while (*next) {
    char *end;
    long pid = strtol(next, &end, 10);
    if (end == next) { next++; continue; }
    next = end;
    if (pid <= 1 || pid > INT_MAX) return -1;
    char status_path[64], status[8192];
    snprintf(status_path, sizeof(status_path), "/proc/%ld/status", pid);
    int status_fd = open(status_path, O_RDONLY | O_CLOEXEC);
    ssize_t status_size = status_fd < 0 ? -1 : read(status_fd, status, sizeof(status) - 1);
    if (status_fd >= 0) close(status_fd);
    if (status_size <= 0) return -1;
    status[status_size] = 0;
    char *parent_field = strstr(status, "\nPPid:");
    if (!parent_field || strtol(parent_field + 6, NULL, 10) != getpid()) return -1;
    int owned = syscall(SYS_pidfd_open, (pid_t)pid, 0);
    if (owned < 0) return -1;
    status_fd = open(status_path, O_RDONLY | O_CLOEXEC);
    status_size = status_fd < 0 ? -1 : read(status_fd, status, sizeof(status) - 1);
    if (status_fd >= 0) close(status_fd);
    if (status_size <= 0) { close(owned); return -1; }
    status[status_size] = 0;
    parent_field = strstr(status, "\nPPid:");
    if (!parent_field || strtol(parent_field + 6, NULL, 10) != getpid()) { close(owned); return -1; }
    int sent = syscall(SYS_pidfd_send_signal, owned, SIGKILL, NULL, 0);
    int error = errno;
    close(owned);
    if (sent < 0 && error != ESRCH) return -1;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) return 125;
  pid_t parent = getppid(), owner = getpid();
  sigset_t events;
  sigemptyset(&events);
  sigaddset(&events, SIGTERM); sigaddset(&events, SIGINT);
  sigaddset(&events, SIGHUP); sigaddset(&events, SIGCHLD);
  struct sigaction ignore = { .sa_handler = SIG_IGN };
  if (sigprocmask(SIG_BLOCK, &events, NULL) || sigaction(SIGPIPE, &ignore, NULL) ||
      prctl(PR_SET_CHILD_SUBREAPER, 1) || prctl(PR_SET_PDEATHSIG, SIGTERM) ||
      getppid() != parent || parent == 1) return 125;
  int signal_fd = signalfd(-1, &events, SFD_CLOEXEC);
  int gate[2], info[2], block[2];
  if (signal_fd < 0 || pipe2(gate, O_CLOEXEC) || pipe2(info, O_CLOEXEC) || pipe2(block, O_CLOEXEC)) return 125;
  pid_t child = fork();
  if (child < 0) return 125;
  if (child == 0) {
    close(3); close(gate[1]); close(info[0]); close(block[1]); close(signal_fd);
    sigset_t empty; sigemptyset(&empty); sigprocmask(SIG_SETMASK, &empty, NULL);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != owner) _exit(125);
    char ready;
    ssize_t received;
    do { received = read(gate[0], &ready, 1); } while (received < 0 && errno == EINTR);
    close(gate[0]);
    if (received != 1 || ready != '1' || confine_keys()) _exit(125);
    /* Preserve only these two bootstrap fds; bwrap closes them before exec. */
    int information = fcntl(info[1], F_DUPFD, 10), barrier = fcntl(block[0], F_DUPFD, 10);
    close(info[1]); close(block[0]);
    if (information < 0 || barrier < 0 || dup2(information, 4) < 0 || dup2(barrier, 5) < 0) _exit(125);
    close(information); close(barrier);
    char **arguments = calloc((size_t)argc + 5, sizeof(char *));
    if (!arguments) _exit(125);
    arguments[0] = argv[1]; arguments[1] = "--info-fd"; arguments[2] = "4";
    arguments[3] = "--block-fd"; arguments[4] = "5";
    for (int index = 2; index < argc; index++) arguments[index + 3] = argv[index];
    execv(argv[1], arguments); _exit(125);
  }
  close(gate[0]); close(info[1]); close(block[0]);
  int pidfd = syscall(SYS_pidfd_open, child, 0), namespace_fd = -1;
  int stopping = pidfd < 0, failed = pidfd < 0, stopped = 0, child_status = 125 << 8;
  if (!stopping && write(gate[1], "1", 1) != 1) stopping = 1;
  close(gate[1]);
  char json[8192] = {0}; size_t length = 0;
  while (!failed && namespace_fd < 0) {
    struct pollfd descriptors[] = {{info[0], POLLIN, 0}, {signal_fd, POLLIN, 0}, {pidfd, POLLIN, 0}};
    int ready;
    do { ready = poll(descriptors, 3, 15000); } while (ready < 0 && errno == EINTR);
    if (ready <= 0 || descriptors[2].revents) { stopping = 1; failed = 1; break; }
    if (descriptors[1].revents) {
      struct signalfd_siginfo event;
      if (read(signal_fd, &event, sizeof(event)) != sizeof(event) || event.ssi_signo != SIGCHLD) stopping = 1;
      /* Retain the blocked init before servicing a stop or parent death. */
    }
    if (descriptors[0].revents) {
      ssize_t count = read(info[0], json + length, sizeof(json) - length - 1);
      if (count <= 0) { stopping = 1; failed = 1; break; }
      length += (size_t)count;
      if (length >= sizeof(json) - 1) { stopping = 1; failed = 1; break; }
      if (!strchr(json, '}')) continue;
      char *field = strstr(json, "\"child-pid\"");
      char *colon = field ? strchr(field, ':') : NULL, *end;
      long namespace_pid = colon ? strtol(colon + 1, &end, 10) : 0;
      if (!colon || end == colon + 1 || namespace_pid <= 1 || namespace_pid > INT_MAX || namespace_pid == child || namespace_pid == owner) { stopping = 1; failed = 1; break; }
      /* The payload remains blocked. Validate ownership again after opening
       * the pidfd; bubblewrap can reap a failed init during setup. */
      char path[64], status[8192];
      snprintf(path, sizeof(path), "/proc/%ld/status", namespace_pid);
      int record = open(path, O_RDONLY | O_CLOEXEC);
      ssize_t size = record < 0 ? -1 : read(record, status, sizeof(status) - 1);
      if (record >= 0) close(record);
      if (size <= 0) { stopping = 1; failed = 1; break; }
      status[size] = 0;
      char *ppid = strstr(status, "\nPPid:");
      long recorded_parent = ppid ? strtol(ppid + 6, NULL, 10) : 0;
      if (recorded_parent != child && recorded_parent != owner) { stopping = 1; failed = 1; break; }
      namespace_fd = syscall(SYS_pidfd_open, (pid_t)namespace_pid, 0);
      record = open(path, O_RDONLY | O_CLOEXEC);
      size = record < 0 ? -1 : read(record, status, sizeof(status) - 1);
      if (record >= 0) close(record);
      if (size > 0) status[size] = 0;
      ppid = size > 0 ? strstr(status, "\nPPid:") : NULL;
      recorded_parent = ppid ? strtol(ppid + 6, NULL, 10) : 0;
      if (namespace_fd < 0 || (recorded_parent != child && recorded_parent != owner)) {
        if (namespace_fd >= 0) close(namespace_fd);
        namespace_fd = -1;
        stopping = 1; failed = 1;
      } else if (!stopping && write(3, "R", 1) != 1) { stopping = 1; failed = 1; }
      close(3);
      if (!stopping && write(block[1], "1", 1) != 1) { stopping = 1; failed = 1; }
    }
  }
  close(info[0]);
  /* EOF on bwrap block-fd releases execution. Keep it open through cleanup. */
  for (;;) {
    if (stopping && !stopped) {
      if (namespace_fd >= 0 && syscall(SYS_pidfd_send_signal, namespace_fd, SIGKILL, NULL, 0) < 0 && errno != ESRCH) failed = 1;
      if (pidfd >= 0 && syscall(SYS_pidfd_send_signal, pidfd, SIGKILL, NULL, 0) < 0 && errno != ESRCH) failed = 1;
      stopped = 1;
    }
    if (stopping && kill_adopted() < 0) _exit(126);
    int status;
    pid_t reaped = waitpid(-1, &status, WNOHANG);
    if (reaped == 0) {
      struct signalfd_siginfo event;
      ssize_t received;
      do { received = read(signal_fd, &event, sizeof(event)); } while (received < 0 && errno == EINTR);
      if (received != sizeof(event) || event.ssi_signo != SIGCHLD) stopping = 1;
      continue;
    }
    if (reaped == child) { child_status = status; stopping = 1; }
    if (reaped > 0) continue;
    if (errno == EINTR) continue;
    if (errno == ECHILD) break;
    /* Reserved uncertainty code; never report successful ownership cleanup. */
    _exit(126);
  }
  if (pidfd >= 0) close(pidfd);
  if (namespace_fd >= 0) close(namespace_fd);
  close(block[1]); close(3); close(signal_fd);
  if (failed) return 125;
  int result = WIFEXITED(child_status) ? WEXITSTATUS(child_status) : 128 + WTERMSIG(child_status);
  return result == 126 ? 125 : result;
}
