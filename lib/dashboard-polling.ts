type DashboardPollingOptions = {
  isHidden: () => boolean;
  canPoll: () => boolean;
  lastRequestAt: () => number | null;
  poll: () => void;
  now: () => number;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (timer: number) => void;
  subscribeVisibility: (callback: () => void) => () => void;
};

export const dashboardPollingIntervalMs = 60_000;

/** Only visible pages poll; elapsed background intervals never form a queue. */
export function startDashboardPolling(options: DashboardPollingOptions) {
  const mountedAt = options.now();
  let stopped = false;
  let timer: number | undefined;

  function clear() {
    if (timer !== undefined) options.clearTimer(timer);
    timer = undefined;
  }

  function remaining() {
    return Math.max(0, (options.lastRequestAt() ?? mountedAt) + dashboardPollingIntervalMs - options.now());
  }

  function schedule(delay: number) {
    clear();
    if (!stopped && !options.isHidden()) timer = options.setTimer(tick, delay);
  }

  function tick() {
    timer = undefined;
    if (stopped || options.isHidden()) return;
    const delay = remaining();
    if (delay > 0) {
      schedule(delay);
      return;
    }
    try {
      if (options.canPoll()) options.poll();
    } finally {
      // A blocked/in-flight request must not create a zero-delay retry loop.
      schedule(dashboardPollingIntervalMs);
    }
  }

  function visibilityChanged() {
    clear();
    if (stopped || options.isHidden()) return;
    if (remaining() === 0) tick();
    else schedule(remaining());
  }

  const unsubscribe = options.subscribeVisibility(visibilityChanged);
  // Keep mounting passive: StrictMode's first cleanup can cancel an overdue
  // zero-delay timer before its second mount installs the real subscriber.
  schedule(remaining());
  return () => {
    stopped = true;
    clear();
    unsubscribe();
  };
}
