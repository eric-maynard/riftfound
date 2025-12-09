import { Outlet } from 'react-router-dom';

function Layout() {
  return (
    <div className="layout">
      <main>
        <div className="container">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export default Layout;
