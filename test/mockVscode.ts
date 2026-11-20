export class MockPosition {
  constructor(public line: number, public character: number) {}
}

export class MockRange {
  constructor(public start: MockPosition, public end: MockPosition) {}
}

export class MockUri {
  constructor(public fsPath: string, public scheme = 'file') {}
  static file(pathStr: string): MockUri {
    return new MockUri(pathStr, 'file');
  }
  static parse(uriStr: string): MockUri {
    return new MockUri(uriStr.replace('untitled:', ''), 'untitled');
  }
}

export class MockEventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  public event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  public fire(data: T): void {
    for (const l of this.listeners) {
      l(data);
    }
  }
}

export const mockVscode = {
  workspace: {
    workspaceFolders: [
      {
        uri: MockUri.file(process.cwd()),
        name: 'Ezra',
        index: 0,
      },
    ],
    asRelativePath: (pathOrUri: string | MockUri) => {
      const p = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
      return p.replace(process.cwd() + '/', '');
    },
    getConfiguration: () => ({
      get: (key: string, defVal: any) => defVal,
    }),
    findFiles: async () => [],
    applyEdit: async () => true,
    openTextDocument: async (uri: MockUri) => ({
      uri,
      save: async () => true,
    }),
  },
  window: {
    showInformationMessage: async () => {},
    showWarningMessage: async () => {},
    showErrorMessage: async () => {},
    activeTextEditor: undefined,
  },
  commands: {
    executeCommand: async () => [],
    registerCommand: () => ({ dispose: () => {} }),
  },
  Position: MockPosition,
  Range: MockRange,
  Uri: MockUri,
  EventEmitter: MockEventEmitter,
  SymbolKind: {
    File: 0,
    Module: 1,
    Function: 11,
    Class: 4,
    Method: 5,
  },
};

