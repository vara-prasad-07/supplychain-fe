import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { LayoutDashboard, Package, Radio, Shield, ChevronLeft, ChevronRight } from 'lucide-react'

const navItems = [
  { path: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { path: '/shipments', label: 'Shipments', icon: Package },
  { path: '/live-ops', label: 'Live Ops', icon: Radio },
]

export default function Sidebar() {
  const location = useLocation()
  const [isCollapsed, setIsCollapsed] = useState(false)

  return (
    <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon">
          <img src="/logo.png" alt="AegisChain Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>
        {!isCollapsed && <h1>AegisChain</h1>}
      </div>

      <nav className="sidebar-nav">
        {!isCollapsed && <div className="sidebar-section-label">Navigation</div>}
        {navItems.map(item => {
          const Icon = item.icon
          const isActive = location.pathname === item.path ||
            (item.path === '/shipments' && location.pathname.startsWith('/shipments'))
          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={`sidebar-link ${isActive ? 'active' : ''}`}
              title={isCollapsed ? item.label : ''}
            >
              <Icon size={18} />
              {!isCollapsed && item.label}
            </NavLink>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-status">
          <span className="sidebar-status-dot" />
          {!isCollapsed && 'All Systems Operational'}
        </div>
        <button 
          className="sidebar-toggle-btn"
          onClick={() => setIsCollapsed(!isCollapsed)}
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>
    </aside>
  )
}
