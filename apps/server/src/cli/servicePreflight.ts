import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { Command, Flag } from "effect/cli";

import { runServicePreflight } from "../cloud/servicePreflight.ts";

// The caller parses stdout as exactly one JSON line, so anything the
// migrations log goes to stderr instead.
const stderrLogger = Logger.layer([Logger.withConsoleError(Logger.formatSimple)]);

export const servicePreflightCommand = Command.make("__service-preflight", {
  databasePath: Flag.String("database-path"),
  launcherProtocol: Flag.Int("launcher-protocol"),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ databasePath, launcherProtocol }) =>
    runServicePreflight({ databasePath, launcherProtocol }).pipe(
      Effect.provide(stderrLogger),
      Effect.flatMap((result) => Console.log(JSON.stringify(result))),
    ),
  ),
);
