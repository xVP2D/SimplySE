import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Agents } from "./pages/Agents";
import { AgentDetail } from "./pages/AgentDetail";
import { Denials } from "./pages/Denials";
import { Matrix } from "./pages/Matrix";
import { Deployments } from "./pages/Deployments";
import { Alerts } from "./pages/Alerts";
import { Compliance } from "./pages/Compliance";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="agents" element={<Agents />} />
        <Route path="agents/:id" element={<AgentDetail />} />
        <Route path="denials" element={<Denials />} />
        <Route path="matrix" element={<Matrix />} />
        <Route path="deployments" element={<Deployments />} />
        <Route path="compliance" element={<Compliance />} />
        <Route path="alerts" element={<Alerts />} />
      </Route>
    </Routes>
  );
}
