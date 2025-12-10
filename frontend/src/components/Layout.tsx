import { Outlet } from 'react-router-dom';

function Layout() {
  return (
    <div className="layout">
      <main>
        <div className="container">
          <Outlet />
        </div>
      </main>
      <footer className="site-footer">
        <div className="container">
          Powered by the <a href="https://locator.riftbound.uvsgames.com/" target="_blank" rel="noopener noreferrer">Official Locator</a>
          {' | '}
          <a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noopener noreferrer">Apache 2.0 License</a>
          {' | '}
          <a href="https://github.com/eric-maynard/riftfound" target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
      </footer>
    </div>
  );
}

export default Layout;
