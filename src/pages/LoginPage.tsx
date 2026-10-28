import { FormEvent, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { APP_VERSION, DEFAULT_PASSWORD, LANDING_FOOTER_LABEL } from "../lib/util";

export function LoginPage() {
  const { signIn } = useAuth();
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showLogin, setShowLogin] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await signIn(account.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登入失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app landing-app">
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="./">
            <span className="brand-name">KSSW</span>
          </a>
          <div className="header-right">
            <nav className="header-nav">
              <button type="button" onClick={() => document.getElementById("tools")?.scrollIntoView({ behavior: "smooth" })}>Features</button>
              <button type="button" onClick={() => setShowLogin(true)}>Issues</button>
              <button type="button" onClick={() => setShowLogin(true)}>Schedule</button>
              <button type="button" onClick={() => setShowLogin(true)}>教學</button>
              <button type="button" onClick={() => setShowLogin(true)}>Personnel</button>
            </nav>
            <div className="auth-chip">
              <span className="muted-label">Not signed in</span>
              <button className="btn-blue" type="button" onClick={() => setShowLogin(true)}>Login</button>
            </div>
          </div>
        </div>
      </header>

      <main className="page">
        <section className="hero">
          <h1>
            KSSW <span className="ver">{APP_VERSION}</span>
          </h1>
          <p className="lead">Projects, issues, schedule, 教學, and personnel — one KSSW workspace.</p>
        </section>

        <section className="tool-grid" id="tools" aria-label="Features">
          <article
            className="tool-card"
            role="button"
            tabIndex={0}
            onClick={() => setShowLogin(true)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShowLogin(true); } }}
          >
            <div className="icon-box icon-blue" aria-hidden="true">◇</div>
            <h2>Projects &amp; Issues</h2>
            <p>Manage projects, assign people, and track issue status through Open → Verify.</p>
            <span className="ok-pill">Available</span>
          </article>
          <article
            className="tool-card"
            role="button"
            tabIndex={0}
            onClick={() => setShowLogin(true)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShowLogin(true); } }}
          >
            <div className="icon-box icon-green" aria-hidden="true">▣</div>
            <h2>Schedule &amp; 教學</h2>
            <p>Gantt scheduling and onboarding guides in one place.</p>
            <span className="ok-pill">Available</span>
          </article>
        </section>

        {showLogin && (
          <div className="login-overlay" onClick={() => setShowLogin(false)}>
            <form className="login-card gate-card" onSubmit={onSubmit} onClick={(e) => e.stopPropagation()}>
              <h2 style={{ marginTop: 0 }}>Login</h2>
              <p className="hint">Use the account or EMAIL from Personnel.</p>
              <div className="field">
                <label htmlFor="account">Account</label>
                <input
                  id="account"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  autoComplete="username"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              <p className="gate-error" role="alert">{error}</p>
              <button className="btn-blue" type="submit" disabled={busy}>
                {busy ? "…" : "Login"}
              </button>
            </form>
          </div>
        )}

        <section className="how-card">
          <h2>How to use</h2>
          <ol>
            <li>
              Click <strong>Login</strong> — use the account or EMAIL issued by an Admin via Personnel →{" "}
              <strong>Add Member</strong>. New users: password {DEFAULT_PASSWORD}
            </li>
            <li>After login, use sidebar <strong>Change password</strong> anytime</li>
            <li>Admins manage personnel and issues; members see their own work</li>
            <li>Dashboard summarizes open / alert / closed issues for the selected project filter</li>
          </ol>
        </section>
      </main>

      <footer className="site-footer">{LANDING_FOOTER_LABEL}</footer>
    </div>
  );
}
