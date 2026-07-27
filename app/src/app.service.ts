import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>OrderFlow API</title>
<style>
  :root {
    --bg: #f5f6f8; --surface: #ffffff; --text: #16181d; --mute: #666e7a;
    --line: #dfe3e8; --accent: #3a63d8;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14161b; --surface: #1c1f26; --text: #e7e9ed; --mute: #8b93a1; --line: #2b2f38; --accent: #7c9bef; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: var(--bg); color: var(--text);
    font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
  }
  main {
    max-width: 480px; padding: 2.5rem; background: var(--surface);
    border: 1px solid var(--line); border-radius: 12px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 12px 32px -16px rgba(0,0,0,0.25);
  }
  .eyebrow {
    font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--mute); margin-bottom: 0.4rem;
  }
  h1 { margin: 0 0 0.6rem; font-size: 1.6rem; }
  p { margin: 0 0 1.5rem; color: var(--mute); line-height: 1.5; }
  .links { display: flex; gap: 0.75rem; flex-wrap: wrap; }
  a {
    display: inline-flex; align-items: center; gap: 0.4rem;
    padding: 0.55rem 1rem; border-radius: 8px; font-size: 0.9rem; font-weight: 600;
    text-decoration: none; border: 1px solid var(--line);
  }
  a.primary { background: var(--accent); color: #fff; border-color: transparent; }
  a.secondary { color: var(--text); }
  a:hover { filter: brightness(1.06); }
</style>
</head>
<body>
  <main>
    <div class="eyebrow">Agentic QA Platform</div>
    <h1>OrderFlow API</h1>
    <p>Backend for the order-processing app used as the system under test — Customers, Products,
    Orders, with an OrderStatusHistory audit trail and Kafka status-change events.</p>
    <div class="links">
      <a class="primary" href="/docs">API Docs (Swagger)</a>
      <a class="secondary" href="http://localhost:5173">Open the app</a>
    </div>
  </main>
</body>
</html>`;
  }
}
