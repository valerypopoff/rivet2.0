import 'core-js/actual';
import { QueryClient } from '@tanstack/react-query';
import { RivetAppHost } from './host';
import {
  isRivetWebAppPreviewWindow,
  RivetWebAppPreviewWindow,
} from './components/rivetWebApps/RivetWebAppPreviewWindow.js';

const queryClient = new QueryClient();

function App() {
  if (isRivetWebAppPreviewWindow()) {
    return <RivetWebAppPreviewWindow />;
  }

  return <RivetAppHost queryClient={queryClient} />;
}

export default App;
