import { Outlet, Link } from 'react-router-dom';

function Layout() {
  return (
    <div className="layout">
      <header style={{
        backgroundColor: 'var(--color-bg-secondary)',
        borderBottom: '1px solid var(--color-border)',
        padding: '1rem 0',
      }}>
        <div className="container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Link to="/" style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--color-text)' }}>
            Riftfound
          </Link>
          <nav>
            <Link to="/">Events</Link>
          </nav>
        </div>
      </header>

      <main style={{ padding: '2rem 0' }}>
        <div className="container">
          <Outlet />
        </div>
      </main>

      <footer style={{
        backgroundColor: 'var(--color-bg-secondary)',
        borderTop: '1px solid var(--color-border)',
        padding: '1rem 0',
        marginTop: 'auto',
      }}>
        <div className="container" style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>
          <p>Data sourced from Riftbound Event Locator</p>
        </div>
      </footer>
    </div>
  );
}

export default Layout;
