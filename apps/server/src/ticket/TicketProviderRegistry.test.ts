import {
  TicketProviderDriverKind,
  TicketProviderInstanceId,
  type TicketProviderInstanceConfigMap,
} from "@t3tools/contracts";
import { extractUniqueTicketReference } from "@t3tools/shared/ticketTitles";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { HttpClient } from "effect/unstable/http";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { make, TicketProviderResolveError } from "./TicketProviderRegistry.ts";

const commandOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: 0 as never,
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const githubReference = extractUniqueTicketReference("https://github.com/acme/widgets/issues/12")!;

function makeRegistry(run: VcsProcess.VcsProcess["Service"]["run"]) {
  return make.pipe(
    Effect.provideService(VcsProcess.VcsProcess, { run }),
    Effect.provideService(HttpClient.HttpClient, {
      execute: () => Effect.die("HTTP should not run"),
    } as never),
  );
}

describe("TicketProviderRegistry", () => {
  effectIt.effect("uses the project-bound GitHub account without changing global gh auth", () =>
    Effect.gen(function* () {
      const run = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>((input) =>
        Effect.succeed(
          commandOutput(input.args[0] === "auth" ? "work-token\n" : '{"title":"Fix reconnect"}'),
        ),
      );
      const registry = yield* makeRegistry(run);
      const instances: TicketProviderInstanceConfigMap = {
        [TicketProviderInstanceId.make("github_personal")]: {
          driver: TicketProviderDriverKind.make("github"),
          baseUrl: "https://github.com",
          config: { accountLogin: "personal" },
        },
        [TicketProviderInstanceId.make("github_work")]: {
          driver: TicketProviderDriverKind.make("github"),
          baseUrl: "https://github.com",
          config: { accountLogin: "work" },
        },
      };

      const resolved = yield* registry.resolve({
        cwd: "/tmp/project",
        reference: githubReference,
        instances,
        bindings: [
          {
            driver: TicketProviderDriverKind.make("github"),
            host: "github.com",
            instanceId: TicketProviderInstanceId.make("github_work"),
          },
        ],
      });

      expect(resolved).toMatchObject({
        title: "Fix reconnect",
        identifier: "acme/widgets#12",
        provider: "GitHub",
      });
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[0]?.[0]).toMatchObject({
        command: "gh",
        args: ["auth", "token", "--hostname", "github.com", "--user", "work"],
      });
      expect(run.mock.calls[1]?.[0]).toMatchObject({
        command: "gh",
        args: ["issue", "view", "https://github.com/acme/widgets/issues/12", "--json", "title"],
        env: expect.objectContaining({ GH_TOKEN: "work-token", GH_HOST: "github.com" }),
      });
    }),
  );

  effectIt.effect(
    "does not fall through to another account when an explicit binding is unavailable",
    () =>
      Effect.gen(function* () {
        const run = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>(() =>
          Effect.succeed(commandOutput('{"title":"should not resolve"}')),
        );
        const registry = yield* makeRegistry(run);
        const failure = yield* Effect.flip(
          registry.resolve({
            cwd: "/tmp/project",
            reference: githubReference,
            instances: {
              [TicketProviderInstanceId.make("github_personal")]: {
                driver: TicketProviderDriverKind.make("github"),
                baseUrl: "https://github.com",
              },
            },
            bindings: [
              {
                driver: TicketProviderDriverKind.make("github"),
                host: "github.com",
                instanceId: TicketProviderInstanceId.make("github_removed"),
              },
            ],
          }),
        );

        expect(failure).toBeInstanceOf(TicketProviderResolveError);
        expect(failure.reason).toBe("no-instance");
        expect(run).not.toHaveBeenCalled();
      }),
  );

  effectIt.effect("uses the single compatible local CLI when no instance is configured", () =>
    Effect.gen(function* () {
      const run = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>(() =>
        Effect.succeed(commandOutput('{"title":"Public issue"}')),
      );
      const registry = yield* makeRegistry(run);

      const resolved = yield* registry.resolve({
        cwd: "/tmp/project",
        reference: githubReference,
        instances: {},
        bindings: [],
      });

      expect(resolved.title).toBe("Public issue");
      expect(run.mock.calls[0]?.[0]).toMatchObject({ command: "gh" });
    }),
  );

  effectIt.effect("tests the configured GitHub account without changing active gh auth", () =>
    Effect.gen(function* () {
      const run = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>(() =>
        Effect.succeed(commandOutput("token\n")),
      );
      const registry = yield* makeRegistry(run);
      const instanceId = TicketProviderInstanceId.make("github_work");

      const result = yield* registry.probe({
        cwd: "/tmp/project",
        instanceId,
        instance: {
          driver: TicketProviderDriverKind.make("github"),
          baseUrl: "https://github.com",
          config: { accountLogin: "work" },
        },
      });

      expect(result).toEqual({
        instanceId,
        availability: "available",
        detail: "Connection test succeeded.",
      });
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "gh",
          args: ["auth", "token", "--hostname", "github.com", "--user", "work"],
        }),
      );
    }),
  );

  effectIt.effect("reports probe failures without exposing command output", () =>
    Effect.gen(function* () {
      const run = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>(() =>
        Effect.die("sensitive stderr"),
      );
      const registry = yield* makeRegistry(run);
      const instanceId = TicketProviderInstanceId.make("github_work");

      const result = yield* registry.probe({
        cwd: "/tmp/project",
        instanceId,
        instance: {
          driver: TicketProviderDriverKind.make("github"),
          baseUrl: "https://github.com",
        },
      });

      expect(result).toEqual({
        instanceId,
        availability: "unavailable",
        detail: "Connection test failed. Check the local CLI login or configured credential.",
      });
      expect(result.detail).not.toContain("sensitive stderr");
    }),
  );

  effectIt.effect("passes a configured Azure DevOps Server collection to the CLI", () =>
    Effect.gen(function* () {
      const run = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>(() =>
        Effect.succeed(commandOutput("Fix reconnect\n")),
      );
      const registry = yield* makeRegistry(run);
      const baseUrl = "https://devops.internal/tfs/DefaultCollection";
      const reference = extractUniqueTicketReference(`${baseUrl}/Widgets/_workitems/edit/77`, [
        { driver: TicketProviderDriverKind.make("azure-devops"), baseUrl },
      ])!;

      const result = yield* registry.resolve({
        cwd: "/tmp/project",
        reference,
        instances: {
          [TicketProviderInstanceId.make("azure_work")]: {
            driver: TicketProviderDriverKind.make("azure-devops"),
            baseUrl,
          },
        },
        bindings: [],
      });

      expect(result.title).toBe("Fix reconnect");
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "az",
          args: expect.arrayContaining(["--organization", baseUrl]),
        }),
      );
    }),
  );

  effectIt.effect("deduplicates only simultaneous lookups for the same ticket and account", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const run = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(commandOutput('{"title":"Shared result"}')),
        ),
      );
      const registry = yield* makeRegistry(run);
      const input = {
        cwd: "/tmp/project",
        reference: githubReference,
        instances: {},
        bindings: [],
      } as const;

      const resolving = yield* Effect.all([registry.resolve(input), registry.resolve(input)], {
        concurrency: "unbounded",
      }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      const resolved = yield* Fiber.join(resolving);

      expect(resolved.map((ticket) => ticket.title)).toEqual(["Shared result", "Shared result"]);
      expect(run).toHaveBeenCalledTimes(1);
    }),
  );
});
