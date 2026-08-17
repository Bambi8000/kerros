import { ErrorBoundary } from './ui/ErrorBoundary';
import { Layout } from './ui/Layout';

export default function App() {
  return (
    <ErrorBoundary label="Kerros">
      <Layout />
    </ErrorBoundary>
  );
}
