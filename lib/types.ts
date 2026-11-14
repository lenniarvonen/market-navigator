export type Source = { name: string; url?: string; date?: string };

export type Round = {
  type?: string;
  amountEur?: number;
  year?: number;
  investors: string[];
  sources: Source[];
};

export type Peer = {
  id?: string;
  name: string;
  isTarget?: boolean;
  description?: string;
  country?: string;
  foundedYear?: number;
  employees?: number;
  fundingEur?: number; // total known funding, normalised to EUR
  fundingLabel?: string; // as Cala reported it, e.g. "€38.9M"
  lastRound?: string;
  share?: number; // share of the peer set's known capital, 0..1
  rounds?: Round[];
  via: ("industry" | "similar-search" | "competitor-search")[];
  sources: Source[];
};

export type YearBucket = { year: number; rounds: number; capitalEur: number; early: number; later: number };

export type Momentum = {
  years: YearBucket[];
  trend: "rising" | "flat" | "falling" | "unknown";
  earlyShare?: number; // share of rounds in the window that were pre-seed/seed
  top3Share: number; // capital concentration across the peer set
  crowding: "crowded" | "contested" | "open" | "unknown";
  sources: Source[];
};

export type Investor = { id?: string; name: string; rounds: number; peers: string[]; sources: Source[] };

export type Gap = { title: string; detail: string; peers: string[] };

export type MoatSignal = {
  key: string;
  label: string;
  target?: number | string;
  peerMedian?: number;
  verdict: "stronger" | "similar" | "weaker" | "unknown";
  note?: string;
  sources: Source[];
};

export type Evidence = {
  kind: "owns_peer" | "deal_with_peer" | "sector_deal";
  text: string;
  sources: Source[];
};

export type Acquirer = { id?: string; name: string; score: number; evidence: Evidence[] };

export type MarketMap = {
  input: { idea?: string; company?: string };
  mode: "live" | "demo";
  /** The founder's company, when they gave one and Cala knows it. */
  target?: { id?: string; name: string; description?: string };
  industry?: string;
  peers: Peer[];
  capital: { totalEur: number; peersWithFunding: number; top3Share: number };
  momentum: Momentum;
  investors: { available: boolean; list: Investor[] };
  standout: { gaps: Gap[]; position: MoatSignal[]; generatedBy: "claude" | "template" };
  acquirers: Acquirer[];
  summary: string;
  warnings: string[];
  generatedAt: string;
};
