/* 视图边界：某一页渲染时抛了异常，只让这一页显示「没能显示」，左栏、控制台、其他页照常可用。
   没有它，React 会把整棵树卸掉——整个应用只剩一片空白，只能关掉重开。
   用 key={view} 包住：换到别的页就自动重置；「再试一次」重画这一页；「回到归来」跳去首页。
   文案只写事实（哪一页、什么错误），不拟人。错误详情折在里面，方便复制给人看。 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { actions } from '../../state/actions';
import { Button, EmptyState } from '../ui';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props { name: string; children: ReactNode }
interface State { error: Error | null }

export class ViewBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 留一条控制台记录（探针与开发者能看到），不上传任何地方。
    console.error(`[ViewBoundary] ${this.props.name}页渲染出错：`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="view-error" role="alert">
        <EmptyState
          icon={AlertTriangle}
          title={`「${this.props.name}」这一页没能显示`}
          body={(
            <>
              <p>其他页面不受影响。可以再试一次，或先回到归来。</p>
              <details className="view-error__detail">
                <summary>错误详情</summary>
                <pre>{`${error.name}: ${error.message}`.slice(0, 600)}</pre>
              </details>
            </>
          )}
          actions={(
            <>
              <Button icon={RotateCcw} onClick={() => this.setState({ error: null })}>再试一次</Button>
              <Button variant="secondary" onClick={() => { this.setState({ error: null }); actions.navigate('new'); }}>回到归来</Button>
            </>
          )}
        />
      </div>
    );
  }
}
