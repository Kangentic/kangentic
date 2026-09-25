export interface User {
  id: string;
  email: string;
  password: string;
  role: 'admin' | 'member' | 'viewer';
}

export interface Subscription {
  id: string;
  userId: string;
  plan: 'starter' | 'team' | 'enterprise';
  status: 'active' | 'past_due' | 'cancelled';
  renewsAt: string;
}

export interface Invoice {
  id: string;
  userId: string;
  amountCents: number;
  issuedAt: string;
  paid: boolean;
}

const users: User[] = [
  { id: 'u_1001', email: 'ada@example.com', password: 'correct horse battery staple', role: 'admin' },
  { id: 'u_1002', email: 'bea@example.com', password: 'hunter2', role: 'member' },
];

const subscriptions: Subscription[] = [
  { id: 'sub_501', userId: 'u_1001', plan: 'team', status: 'active', renewsAt: '2026-10-01' },
  { id: 'sub_502', userId: 'u_1002', plan: 'starter', status: 'past_due', renewsAt: '2026-09-14' },
];

const invoices: Invoice[] = [
  { id: 'inv_9001', userId: 'u_1001', amountCents: 4900, issuedAt: '2026-08-01', paid: true },
  { id: 'inv_9002', userId: 'u_1001', amountCents: 4900, issuedAt: '2026-09-01', paid: false },
  { id: 'inv_9003', userId: 'u_1002', amountCents: 1900, issuedAt: '2026-09-01', paid: false },
];

export function findUserByEmail(email: string): User | undefined {
  return users.find((user) => user.email.toLowerCase() === email.toLowerCase());
}

export function listSubscriptions(userId: string): Subscription[] {
  return subscriptions.filter((subscription) => subscription.userId === userId);
}

export function listInvoices(userId: string): Invoice[] {
  return invoices.filter((invoice) => invoice.userId === userId);
}
