import { useEffect, useState } from 'react';
import { apiFetch } from './lib/http-client';
import { LiveUpdates } from './lib/websocket';

interface Subscription {
  id: string;
  plan: string;
  status: string;
  renewsAt: string;
}

export function App() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    apiFetch<Subscription[]>('/subscriptions')
      .then((rows) => { setSubscriptions(rows); setStatus('ready'); })
      .catch(() => setStatus('error'));
    const live = new LiveUpdates(`ws://${window.location.host}/live`);
    live.connect();
    const unsubscribe = live.subscribe((event) => {
      const update = JSON.parse(event.data) as Subscription;
      setSubscriptions((current) => current.map((row) => (row.id === update.id ? update : row)));
    });
    return () => { unsubscribe(); live.close(); };
  }, []);

  return (
    <main>
      <h1>Contoso</h1>
      <p>{status === 'loading' ? 'Loading subscriptions' : `${subscriptions.length} subscriptions`}</p>
      <ul>
        {subscriptions.map((row) => (
          <li key={row.id}>{row.plan} ({row.status}) renews {row.renewsAt}</li>
        ))}
      </ul>
    </main>
  );
}
