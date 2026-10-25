import {
  Component,
  Suspense,
  createElement,
  lazy,
  useState,
  type Attributes,
  type FC,
  type PropsWithRef,
  type ReactNode,
} from 'react';

class LazyComponentErrorBoundary extends Component<
  { children: ReactNode; label: string; onRetry: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert">
        Could not load {this.props.label}.{' '}
        <button type="button" onClick={this.props.onRetry}>
          Retry {this.props.label}
        </button>
      </div>
    );
  }
}

/** Feature-local loading: keep current props in the parent, and retry only on
 * explicit user intent. No application command or data mutation is replayed. */
export function createLazyComponent<Props extends object>(
  load: () => Promise<{ default: FC<Props> }>,
  label: string,
  retryLoad = load,
) {
  let SharedContent = lazy(load);
  function LazyComponent(props: Props) {
    const [{ Content, attempt }, setContent] = useState(() => ({ Content: SharedContent, attempt: 0 }));
    const retry = () => {
      // React.lazy retains a rejection. Publish the explicitly retried loader
      // for future mounts too, so reopening does not resurrect that rejection.
      SharedContent = lazy(retryLoad);
      setContent({ Content: SharedContent, attempt: attempt + 1 });
    };
    return (
      <LazyComponentErrorBoundary key={attempt} label={label} onRetry={retry}>
        <Suspense fallback={<div role="status">Loading {label}…</div>}>
          {createElement<PropsWithRef<Props>>(Content, props as Attributes & PropsWithRef<Props>)}
        </Suspense>
      </LazyComponentErrorBoundary>
    );
  }
  LazyComponent.displayName = `Lazy ${label}`;
  return LazyComponent;
}
