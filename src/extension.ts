import * as path from 'path';
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  Node,
  ScriptTarget,
} from 'typescript';
import * as vscode from 'vscode';

let statusBarItem: vscode.StatusBarItem;

// 全局装饰器集合，用于更新和清除
let decorationType: vscode.TextEditorDecorationType;

let keysCountObj: Record<string, number> = {};

/**
 * 缓存json codelens
 */
let codeLensCache: any = {};

/**
 * 转义正则表达式特殊字符
 * @param str 需要转义的字符串
 * @returns 转义后的字符串
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 在文档中查找指定模式的文本并返回其Range
 * @param document 文档对象
 * @param pattern 正则表达式
 * @param key 要查找的key（用于精准匹配）
 * @returns 匹配到的Range，未找到则返回undefined
 */
function findPatternInDocument(document: vscode.TextDocument, pattern: RegExp, key: string): vscode.Range | undefined {
  // 逐行查找，提高匹配精准度
  for (let line = 0; line < document.lineCount; line++) {
    const lineText = document.lineAt(line).text;
    const match = pattern.exec(lineText);

    if (match) {
      // 提取key的位置（去掉引号）
      const keyStart = match.index + 1; // 跳过开头的引号
      const keyEnd = match.index + match[0].indexOf(':') - 1; // 跳过结尾的引号

      if (keyEnd >= keyStart) {
        const startPos = new vscode.Position(line, keyStart);
        const endPos = new vscode.Position(line, keyEnd + 1);
        return new vscode.Range(startPos, endPos);
      }
    }
  }

  return undefined;
}

/**
 * 获取JSON文件中所有key及其对应的Range
 * @param document 文本编辑器文档对象
 * @returns 包含key名称和range的数组
 */
export function getJsonKeysWithRange(
  document: vscode.TextDocument,
): Array<{ key: string; range: vscode.Range; properties: [] }> {
  // 存储最终结果
  const result: Array<{ key: string; range: vscode.Range; properties: [] }> = [];

  try {
    // 1. 获取文档全部文本
    const text = document.getText();

    // 2. 解析JSON获取AST（使用jsonc-parser支持带注释的JSON）
    const jsonObj = JSON.parse(text);
    // console.log(jsonObj);
    if (!jsonObj) {
      // vscode.window.showErrorMessage('无法解析JSON文件');
      return result;
    }

    // 3. 递归遍历AST节点，提取key的range
    function findKeyRange(obj: any, parentPath: string = '') {
      if (typeof obj !== 'object' || obj === null) {
        return;
      }

      if (Array.isArray(obj) === false) {
        // 处理对象
        for (const key of Object.keys(obj)) {
          const fullKey = parentPath ? `${parentPath}.${key}` : key;
          const keyPattern = new RegExp(`["']${escapeRegExp(key)}["']\\s*:`);

          // 查找这个key在文档中的位置
          const keyRange = findPatternInDocument(document, keyPattern, fullKey);
          if (keyRange) {
            result.push({
              key: fullKey,
              range: keyRange,
              properties: [],
            });
          }

          // 递归处理子对象/数组
          // findKeyRange(obj[key], fullKey);
        }
      } else {
        // 处理数组
        // obj.forEach((item: any, index: number) => {
        //   findKeyRange(item, `${parentPath}[${index}]`);
        // });
      }
    }

    // 开始遍历JSON对象并匹配range
    findKeyRange(jsonObj);
  } catch (error) {
    // vscode.window.showErrorMessage(`解析JSON失败: ${(error as Error).message}`);
  }
  // console.log(result);
  return result;
}

/**
 * 遍历工作区所有TS/TSX文件，查找目标函数的调用
 * @param functionName 目标函数名
 * @param progress 进度对象
 * @param token 取消令牌
 * @returns 所有调用的参数信息（含文件路径）
 */
async function findFunctionCallsInWorkspace(functionName: string = 't'): Promise<
  Array<{
    filePath: string; // 文件路径（相对工作区）
    line: number; // 调用行（从1开始）
    character: number; // 调用列（从1开始）
    params: Array<{
      // 参数信息
      value: string;
      type?: string;
    }>;
  }>
> {
  const workspaceFolder = vscode.workspace.workspaceFolders![0];
  const workspacePath = workspaceFolder.uri.fsPath;

  // 1. 查找工作区内所有TS/TSX文件（排除node_modules、dist等目录）
  const fileUris = await vscode.workspace.findFiles(
    '**/*.{ts,tsx,js,jsx}', // 匹配TS/TSX文件
    '{**/node_modules/**,**/.git/**,**/dist/**}', // 排除无关目录
  );
  // console.log('fileUris', fileUris);
  if (fileUris.length === 0) {
    // vscode.window.showWarningMessage('工作区内未找到TS/TSX文件');
    return [];
  }

  const allCallParams: Array<{
    filePath: string;
    line: number;
    character: number;
    params: Array<{ value: string; type?: string }>;
  }> = [];

  const totalFiles = fileUris.length;
  let processedFiles = 0;

  // 2. 逐个解析文件
  for (const fileUri of fileUris) {
    // 检查是否取消操作
    // if (token.isCancellationRequested) {
    //   break;
    // }

    // 更新进度
    processedFiles++;
    const relativePath = path.relative(workspacePath, fileUri.fsPath);
    // progress.report({
    //   message: `解析中：${relativePath} (${processedFiles}/${totalFiles})`,
    //   increment: 100 / totalFiles,
    // });

    // 读取文件内容
    const document = await vscode.workspace.openTextDocument(fileUri);
    if (!['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(document.languageId)) {
      continue;
    }

    // 解析当前文件的函数调用
    const fileCallParams = getFunctionCallParamsInFile(document, functionName);
    if (fileCallParams.length > 0) {
      // 补充文件路径（相对工作区，更易读）
      const callParamsWithPath = fileCallParams.map((item) => ({
        ...item,
        filePath: relativePath,
      }));
      allCallParams.push(...callParamsWithPath);
    }
  }

  return allCallParams;
}

/**
 * 解析单个文件中目标函数的调用参数（复用原有核心逻辑）
 * @param document 文档对象
 * @param functionName 目标函数名
 * @returns 该文件内的调用参数信息
 */
function getFunctionCallParamsInFile(
  document: vscode.TextDocument,
  functionName: string,
): Array<{
  line: number;
  character: number;
  params: Array<{ value: string; type?: string }>;
}> {
  const fileContent = document.getText();
  const sourceFile = createSourceFile(document.uri.fsPath, fileContent, ScriptTarget.Latest, true);

  const callParams: Array<{
    line: number;
    character: number;
    params: Array<{ value: string; type?: string }>;
  }> = [];

  // 递归遍历AST节点
  function traverseNode(node: Node) {
    if (isCallExpression(node)) {
      // 获取调用的函数名（支持简单的链式调用，如 obj.fn() 取 fn）
      let calleeName: string | undefined;
      if (isIdentifier(node.expression)) {
        calleeName = node.expression.text;
      } else if (isPropertyAccessExpression(node.expression)) {
        // 处理 obj.fn() 这种形式
        calleeName = node.expression.name.text;
      }

      if (calleeName === functionName) {
        // 转换为1索引的行/列（符合用户习惯）
        // const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        node.arguments.map((arg: any) => {
          const paramValue = fileContent.substring(arg.getStart() + 1, arg.getEnd() - 1);
          // console.log(paramValue);
          // 简单类型推断
          let paramType: string | undefined = '';
          if (!keysCountObj[paramValue]) {
            keysCountObj[paramValue] = 1;
          } else {
            keysCountObj[paramValue]++;
          }
          return { value: paramValue, type: paramType };
        });
      }
    }

    forEachChild(node, traverseNode);
  }

  traverseNode(sourceFile);
  return callParams;
}

const statusBarItemLoading = (loading: boolean = false) => {
  if (loading) {
    statusBarItem.text = '$(sync~spin) i18n';
  } else {
    statusBarItem.text = '$(json) i18n';
  }
};

// 激活插件时的入口
export function activate(context: vscode.ExtensionContext) {
  // ========== 1. 创建状态栏项 ==========
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left, // 位置：右侧（Left 为左侧）
    0, // 优先级（数值越大越靠右/左）
  );

  // ========== 2. 配置状态栏样式和内容 ==========
  statusBarItem.text = '$(json) i18n'; // 文本 + 内置图标（tag 是标签图标）
  const tooltip = new vscode.MarkdownString(
    `
 ### i18n-json-code-lens

 - 统计i18n-json对象属性引用次数

 - 点击图标刷新 json codelens
    `,
    true,
  );

  tooltip.isTrusted = true;

  statusBarItem.tooltip = tooltip;
  statusBarItem.command = 'i18n-json-code-lens.countRefs'; // 点击触发的命令

  // ========== 3. 显示状态栏 ==========
  statusBarItem.show();

  // 1. 创建装饰器样式：在属性后方显示引用次数（灰色小字体）
  decorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    after: {
      margin: '0 0 0 8px',
      color: '#999999',
      textDecoration: ';font-size: 0.85em;',
      // fontSize: '0.85em',
      // fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });

  const drawCodeLens = () => {
    const editor = vscode.window.activeTextEditor;
    // console.clear();
    if (!editor) {
      // vscode.window.showErrorMessage('请打开一个TypeScript文件');
      return;
    }
    const document = editor.document;
    const fsPath = document.uri.fsPath;
    if (codeLensCache[fsPath]) {
      editor.setDecorations(decorationType, codeLensCache[fsPath] || []);
    }
  };

  // 注册命令：统计as const对象属性引用次数
  let disposable = vscode.commands.registerCommand('i18n-json-code-lens.countRefs', async () => {
    const editor = vscode.window.activeTextEditor;
    // console.clear();
    if (!editor) {
      // vscode.window.showErrorMessage('请打开一个TypeScript文件');
      return;
    }

    const document = editor.document;
    if (document.languageId !== 'json') {
      // vscode.window.showErrorMessage('仅支持json文件');
      return;
    }
    statusBarItemLoading(true);
    editor.setDecorations(decorationType, []);
    // 1. 解析当前文档，找到所有as const声明的对象
    const fsPath = document.uri.fsPath;

    codeLensCache[fsPath] = [];
    const constObjects = getJsonKeysWithRange(document);

    if (constObjects.length === 0) {
      statusBarItemLoading(false);
      return;
    }
    keysCountObj = {};
    await findFunctionCallsInWorkspace();

    const decorations: vscode.DecorationOptions[] = [];
    constObjects.forEach((item) => {
      const txt = keysCountObj[item.key];
      // codelens 数据
      const data = {
        range: item.range,
        renderOptions: {
          after: {
            contentText: `${txt ? `${txt} 个引用` : '疑是未用'}`,
            color: txt ? undefined : '#ff4d4f',
          },
        },
      };

      codeLensCache[fsPath].push(data);
      decorations.push(data);
    });
    statusBarItemLoading(false);
    // 4. 应用装饰器到编辑器
    editor.setDecorations(decorationType, decorations);
  });

  // 4. 监听编辑器切换，更新装饰器
  let editorChangeListener = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    if (editor && editor.document.languageId === 'json') {
      drawCodeLens();
    }
  });

  // 5. 文档保存监听
  let documentSaveListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (document.languageId === 'json') {
      const fsPath = document.uri.fsPath;
      if (codeLensCache[fsPath]) {
        codeLensCache[fsPath] = [];
        drawCodeLens();
      }
    }
  });

  context.subscriptions.push(disposable, editorChangeListener, documentSaveListener, {
    dispose: () => decorationType.dispose(),
  });
}

export function deactivate() {
  // 销毁装饰器，避免内存泄漏
  if (decorationType) {
    decorationType.dispose();
  }
}
