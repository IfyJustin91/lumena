export interface SponsorRefillOpts {
  targetBalanceXlm: number;
  transfer: (amountXlm: number) => Promise<void>;
  cooldownMs?: number;
}

/** Requests a treasury refill when the sponsor falls below its target balance. */
export class SponsorRefillService {
  private readonly opts: SponsorRefillOpts;
  private lastRefillAt = 0;
  private refillInProgress = false;

  constructor(opts: SponsorRefillOpts) {
    this.opts = opts;
  }

  async refillIfLow(balanceXlm: number, thresholdXlm: number): Promise<boolean> {
    if (
      balanceXlm >= thresholdXlm ||
      this.refillInProgress ||
      Date.now() - this.lastRefillAt < (this.opts.cooldownMs ?? 300_000)
    ) {
      return false;
    }

    const amountXlm = Math.max(this.opts.targetBalanceXlm - balanceXlm, 0);
    if (amountXlm <= 0) {
      return false;
    }

    this.refillInProgress = true;
    try {
      await this.opts.transfer(amountXlm);
      this.lastRefillAt = Date.now();
      return true;
    } finally {
      this.refillInProgress = false;
    }
  }
}