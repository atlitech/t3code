import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import * as BridgeAuth from "../bridge/BridgeAuth.ts";

class BridgeAuthExitError extends CliError.UserError {
  override get message() {
    return "Confined Codex authentication did not complete successfully. See its journal output.";
  }
}

const command = (
  name: "login" | "status" | "logout",
  purpose: Parameters<typeof BridgeAuth.provision>[0]["purpose"],
) =>
  Command.make(name, {
    threadId: Flag.String("thread-id").pipe(Flag.withSchema(ThreadId)),
    workspace: Flag.String("workspace"),
  }).pipe(
    Command.withHandler((input) =>
      Effect.scoped(BridgeAuth.provision({ ...input, purpose })).pipe(
        Effect.flatMap((code) =>
          code === 0
            ? Effect.void
            : Effect.fail(new BridgeAuthExitError({ cause: `Codex exited ${code}` })),
        ),
      ),
    ),
  );

/** This handler constructs no server/provider/auth overlays before mandatory admission. */
export const bridgeAuthCommand = Command.make("bridge-auth").pipe(
  Command.withDescription(
    "Provision one private Codex thread home in the stopped dedicated bridge unit.",
  ),
  Command.withSubcommands([
    command("login", "device-login"),
    command("status", "login-status"),
    command("logout", "logout"),
  ]),
);
