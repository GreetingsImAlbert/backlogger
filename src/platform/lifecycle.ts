export interface AppLifecycleSnapshot {
  foreground: boolean;
  online: boolean;
}

export interface AppLifecycleHandlers {
  onForegroundChanged(foreground: boolean): void | Promise<void>;
  onOnlineChanged(online: boolean): void | Promise<void>;
}

export interface AppLifecycleCoordinatorOptions {
  documentVisible?: boolean;
  nativeFocused?: boolean;
  online?: boolean;
}

/** Combines WebView visibility with native window focus and serializes transitions. */
export class AppLifecycleCoordinator {
  private readonly handlers: AppLifecycleHandlers;
  private documentVisible: boolean;
  private nativeFocused: boolean;
  private foreground: boolean;
  private online: boolean;
  private transitionQueue: Promise<void> = Promise.resolve();

  constructor(handlers: AppLifecycleHandlers, options: AppLifecycleCoordinatorOptions = {}) {
    this.handlers = handlers;
    this.documentVisible = options.documentVisible ?? true;
    this.nativeFocused = options.nativeFocused ?? true;
    this.foreground = this.documentVisible && this.nativeFocused;
    this.online = options.online ?? true;
  }

  snapshot(): AppLifecycleSnapshot {
    return { foreground: this.foreground, online: this.online };
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    const next = this.transitionQueue.then(operation, operation);
    this.transitionQueue = next.catch(() => undefined);
    return next;
  }

  private updateForeground(): Promise<void> {
    const next = this.documentVisible && this.nativeFocused;
    if (next === this.foreground) return this.transitionQueue;
    this.foreground = next;
    return this.enqueue(() => this.handlers.onForegroundChanged(next));
  }

  setDocumentVisible(visible: boolean): Promise<void> {
    if (this.documentVisible === visible) return this.transitionQueue;
    this.documentVisible = visible;
    return this.updateForeground();
  }

  setNativeFocused(focused: boolean): Promise<void> {
    if (this.nativeFocused === focused) return this.transitionQueue;
    this.nativeFocused = focused;
    return this.updateForeground();
  }

  setOnline(online: boolean): Promise<void> {
    if (this.online === online) return this.transitionQueue;
    this.online = online;
    return this.enqueue(() => this.handlers.onOnlineChanged(online));
  }
}
