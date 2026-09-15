import { Router, type Request, type Response, type NextFunction } from 'express';
import { signJwt, verifyJwt, type JwtClaims } from './lib/jwt.ts';
import { checkRateLimit } from './rate-limit.ts';
import { findUserByEmail, listInvoices, listSubscriptions } from './store.ts';

export const router = Router();

type AuthedRequest = Request & { user?: JwtClaims };

router.post('/login', (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  const user = email ? findUserByEmail(email) : undefined;
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  return res.json({ token: signJwt({ sub: user.id, role: user.role }) });
});

router.get('/me', (req: AuthedRequest, res: Response) => {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = verifyJwt(token);
  } catch (error) {
    return res.status(401).json({ error: (error as Error).message });
  }
  return res.json({ id: req.user.sub, role: req.user.role });
});

router.get('/subscriptions', (req: AuthedRequest, res: Response) => {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = verifyJwt(token);
  } catch (error) {
    return res.status(401).json({ error: (error as Error).message });
  }
  if (!checkRateLimit(req.user.sub, 'read')) return res.status(429).json({ error: 'Too many requests' });
  return res.json(listSubscriptions(req.user.sub));
});

router.get('/invoices', (req: AuthedRequest, res: Response) => {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = verifyJwt(token);
  } catch (error) {
    return res.status(401).json({ error: (error as Error).message });
  }
  if (!checkRateLimit(req.user.sub, 'read')) return res.status(429).json({ error: 'Too many requests' });
  return res.json(listInvoices(req.user.sub));
});

router.post('/subscriptions/:id/cancel', (req: AuthedRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = verifyJwt(token);
  } catch (error) {
    return res.status(401).json({ error: (error as Error).message });
  }
  if (!checkRateLimit(req.user.sub, 'write')) return res.status(429).json({ error: 'Too many requests' });
  const subscription = listSubscriptions(req.user.sub).find((entry) => entry.id === req.params.id);
  if (!subscription) return next();
  subscription.status = 'cancelled';
  return res.json(subscription);
});
