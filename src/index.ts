import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Fixed public proof. The query string is ignored. This is not a shell.
const PROOF_ARGV = ["uname", "-s"] as const;
// The object the live public hostname already reads. Do not move it:
// its storage holds the stored uname proof, and a different name would
// miss that proof and could start another container.
const PUBLIC_OBJECT = "proof";
// Separate object for the service-binding exec. The container app is the
// same sandbox-sdk-1-proof application; this name is not the public one.
const EXEC_OBJECT = "proof-2";
const READY_ATTEMPTS = 20;
const READY_WAIT_MS = 1_000;
// Backup if destroy() fails. Billing is while the instance is running.
const SAFETY_TIMEOUT_MS = 15_000;

type Proof = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  stopped: boolean;
};

function text(value: unknown): string {
  if (typeof value === "string") return value;
  // exec().output().stdout is an ArrayBuffer, not a Uint8Array.
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
  return "";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Service-binding argv only. Never a shell string.
function assertArgv(argv: readonly string[]): string[] {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 4) {
    throw new Error("argv must be 1 to 4 strings");
  }
  for (const part of argv) {
    if (typeof part !== "string" || !/^[A-Za-z0-9._+/-]{1,32}$/.test(part)) {
      throw new Error("argv tokens must be plain words");
    }
  }
  if (argv[0] === "sh" || argv[0] === "bash" || argv[0] === "dash" || argv.includes("-c")) {
    throw new Error("shell invocation is not allowed");
  }
  return [...argv];
}

export class ProofSandbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    // A restarted isolate must not leave a lite instance running.
    // This does not start a container.
    if (container?.running) {
      void ctx.blockConcurrencyWhile(async () => {
        try {
          await container.setInactivityTimeout(SAFETY_TIMEOUT_MS);
        } catch {
          // The destroy below is the actual stop.
        }
        try {
          await container.destroy();
        } catch {
          // Platform will still honor the inactivity timeout.
        }
      });
    }
  }

  async fetch(): Promise<Response> {
    const done = await this.ctx.storage.get<Proof>("proof");
    if (done && done.stdout.length > 0) return Response.json(done);

    const attempted = await this.ctx.storage.get<string>("attempted");
    // The first proof stored an empty stdout (ArrayBuffer was not decoded).
    // Allow exactly one more start, and mark it before the container starts
    // so a failure cannot loop into a third instance.
    const rerun = await this.ctx.storage.get<string>("rerun");
    const canRerun = Boolean(done && done.stdout.length === 0 && !rerun);
    if (attempted && !canRerun) {
      return Response.json(
        {
          error: "proof already attempted; container will not start again",
          detail: attempted,
        },
        { status: 409 },
      );
    }
    if (canRerun) await this.ctx.storage.put("rerun", "once");

    // One shot. A later request must not start another instance.
    await this.ctx.storage.put("attempted", "started");

    try {
      const proof = await this.execArgv([...PROOF_ARGV]);
      proof.stopped = true;
      await this.ctx.storage.put("proof", proof);
      return Response.json(proof);
    } catch (error) {
      const detail = message(error);
      await this.ctx.storage.put("attempted", detail);
      return Response.json({ error: detail, stopped: true }, { status: 500 });
    }
  }

  // Service binding only. Does not touch the stored public "proof" key.
  async runBound(argv: string[]): Promise<Proof> {
    const command = assertArgv(argv);
    const done = await this.ctx.storage.get<Proof>("os-exec");
    if (done && done.stdout.length > 0) return { ...done, stopped: true };

    const attempted = await this.ctx.storage.get<string>("os-exec-attempted");
    if (attempted) {
      throw new Error("os-path exec already attempted; container will not start again");
    }
    await this.ctx.storage.put("os-exec-attempted", "started");

    try {
      const proof = await this.execArgv(command);
      proof.stopped = true;
      await this.ctx.storage.put("os-exec", proof);
      return proof;
    } catch (error) {
      const detail = message(error);
      await this.ctx.storage.put("os-exec-attempted", detail);
      throw new Error(detail);
    }
  }

  private async execArgv(argv: string[]): Promise<Proof> {
    const container = this.ctx.container;
    if (!container) throw new Error("No container is configured");

    try {
      if (!container.running) {
        container.start({
          image: "cloudflare/debian-trixie",
          instance: "lite",
          enableInternet: false,
          entrypoint: ["sleep", "infinity"],
        });
      }
      await container.setInactivityTimeout(SAFETY_TIMEOUT_MS);

      let last = "container not ready";
      let proof: Proof | undefined;
      for (let i = 0; i < READY_ATTEMPTS; i++) {
        try {
          const proc = await container.exec(argv);
          const output = await proc.output();
          proof = {
            command: argv.join(" "),
            stdout: text(output.stdout),
            stderr: text(output.stderr),
            exitCode: output.exitCode,
            stopped: false,
          };
          break;
        } catch (error) {
          last = message(error);
          await scheduler.wait(READY_WAIT_MS);
        }
      }
      if (!proof) throw new Error(last);
      return proof;
    } finally {
      if (container.running) {
        try {
          await container.destroy();
        } catch {
          // Inactivity timeout still stops the instance.
        }
      }
    }
  }
}

// Reachable only through a service binding. The public fetch handler never calls it.
export class SandboxExec extends WorkerEntrypoint<Env> {
  async exec(argv: string[]): Promise<Proof> {
    const command = assertArgv(argv);
    const stub = this.env.SANDBOX.getByName(EXEC_OBJECT);
    return stub.runBound(command);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Query string and body are ignored. This is not a shell.
    if (request.method !== "GET" || url.pathname !== "/") {
      return new Response("not found", { status: 404 });
    }
    const stub = env.SANDBOX.getByName(PUBLIC_OBJECT);
    return stub.fetch("https://sandbox.internal/");
  },
} satisfies ExportedHandler<Env>;
