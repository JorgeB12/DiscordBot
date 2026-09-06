type Stateful = {
  state: { status: string };
  on(event: "stateChange", listener: () => void): unknown;
  off(event: "stateChange", listener: () => void): unknown;
};

export function waitForStatus(
  target: Stateful,
  status: string,
  timeoutMs: number,
): Promise<void> {
  if (target.state.status === status) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for ${status} (${timeoutMs}ms)`));
    }, timeoutMs);

    const onChange = () => {
      if (target.state.status === status) {
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      target.off("stateChange", onChange);
    };

    target.on("stateChange", onChange);
  });
}
