import { createSourceFile, forEachChild, isPropertyAccessExpression, Node, ScriptTarget } from 'typescript';
import * as vscode from 'vscode';
import { ILocation, IRefCounts } from './types';
import { toArray, uKey } from './util';

let statusBarItem: vscode.StatusBarItem;

// 全局装饰器集合，用于更新和清除
let decorationType: vscode.TextEditorDecorationType;
/** 引用数据 */
let refCountsGlobal: IRefCounts[] = [];

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
    console.log(jsonObj);
    if (!jsonObj) {
      // vscode.window.showErrorMessage('无法解析JSON文件');
      return result;
    }

    // 3. 递归遍历AST节点，提取key的range
    function findKeyRange(obj: any, parentPath: string = '') {
      if (typeof obj !== 'object' || obj === null) {
        return;
      }

      // 处理对象
      if (Array.isArray(obj) === false) {
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
          findKeyRange(obj[key], fullKey);
        }
      } else {
        // 处理数组
        obj.forEach((item: any, index: number) => {
          findKeyRange(item, `${parentPath}[${index}]`);
        });
      }
    }

    // 开始遍历JSON对象并匹配range
    findKeyRange(jsonObj);
  } catch (error) {
    // vscode.window.showErrorMessage(`解析JSON失败: ${(error as Error).message}`);
  }
  console.log(result);
  return result;
}

// 激活插件时的入口
export function activate(context: vscode.ExtensionContext) {
  // ========== 1. 创建状态栏项 ==========
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left, // 位置：右侧（Left 为左侧）
    0, // 优先级（数值越大越靠右/左）
  );

  // ========== 2. 配置状态栏样式和内容 ==========
  statusBarItem.text = '$(tag) json'; // 文本 + 内置图标（tag 是标签图标）
  const tooltip = new vscode.MarkdownString(
    `
 ### i18n-json-code-lens

 统计as const对象属性引用次数
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

  const commandDisposable = vscode.commands.registerCommand(
    'i18n-json-code-lens.openFile', // 命令名（需唯一）
    async (args: any) => {
      // console.log('key', args.key, 'locationKey', args.locationKey);

      const item = refCountsGlobal.find((el) => el.key === args.key);
      // console.log(item);
      if (!item) return;

      const location = toArray(item.location).find((el) => el.key === args.locationKey);
      if (!location) return;

      try {
        const doc = await vscode.workspace.openTextDocument(location.uri);
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Active,
          preview: true,
          selection: new vscode.Range(
            new vscode.Position(location.line, location.column),
            new vscode.Position(location.line, location.column),
          ),
        });
      } catch (err) {
        vscode.window.showErrorMessage(`打开失败：${err}`);
      }
    },
  );

  // 注册命令：统计as const对象属性引用次数
  let disposable = vscode.commands.registerCommand('i18n-json-code-lens.countRefs', async () => {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      // vscode.window.showErrorMessage('请打开一个TypeScript文件');
      return;
    }
    editor.setDecorations(decorationType, []);
    const document = editor.document;
    if (document.languageId !== 'json') {
      // vscode.window.showErrorMessage('仅支持TypeScript文件');
      return;
    }
    // 1. 解析当前文档，找到所有as const声明的对象
    const constObjects = getJsonKeysWithRange(document);

    // console.log('constObjects', constObjects);

    if (constObjects.length === 0) {
      // vscode.window.showInformationMessage('未找到as const声明的对象');
      return;
    }

    // 2. 统计每个属性的引用次数
    const refCounts = await countPropertyReferences(constObjects as any, document.uri.fsPath, document);
    refCountsGlobal = refCounts;
    // 3. 展示结果
    // let resultMsg = 'as const对象属性引用统计：\n';
    const decorations: vscode.DecorationOptions[] = [];
    refCounts.forEach((item) => {
      // resultMsg += `${item.objectName}.${item.propertyName}: ${item.count} 次引用\n`;
      // console.log('item', item);

      if (item.range) {
        const location = toArray(item.location) as ILocation[];
        if (location.length) {
          const md = new vscode.MarkdownString();
          md.isTrusted = true;
          md.appendMarkdown(`${item.objectName}.${item.propertyName} 引用了 ${item.count} 次\n\n`);
          location.forEach((el, i) => {
            md.appendMarkdown(
              `[${i + 1}. ${el.relativePath} 行 ${el.line}, 列 ${
                el.column
              }](command:i18n-json-code-lens.openFile?${JSON.stringify({
                key: item.key,
                locationKey: el.key,
              })})${i == location.length - 1 ? '' : '\n\n --- \n\n'}`,
            );
          });

          // md.appendMarkdown(`[测试](command:i18n-json-code-lens.test?${item.key})`);
          decorations.push({
            range: item.range,
            hoverMessage: md,
            renderOptions: { after: { contentText: `${item.count}个引用` } },
          });
        } else {
          decorations.push({
            range: item.range,
            renderOptions: { after: { contentText: `${item.count}个引用` } },
          });
        }
      }
    });

    // 4. 应用装饰器到编辑器
    editor.setDecorations(decorationType, decorations);

    // vscode.window.showInformationMessage(resultMsg);
  });

  context.subscriptions.push(disposable, commandDisposable, {
    dispose: () => decorationType.dispose(),
  });
}

/**
 * 获取工作区中所有文件的符号信息
 * @param includePattern 要包含的文件匹配模式（如 ['** /*.ts', '** /*.js']），默认匹配所有文件
 * @param excludePattern 要排除的文件匹配模式（如 ['** /node_modules/**']）
 * @returns 所有文件的符号信息数组
 */
export async function getWorkspaceAllSymbols(): Promise<Array<vscode.DocumentSymbol>> {
  const allSymbols: Array<vscode.DocumentSymbol> = [];

  // 1. 获取当前工作区（多工作区场景取第一个）
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('当前没有打开的工作区');
    return allSymbols;
  }

  // 2. 配置文件查找选项
  const fileFindOptions: any = {
    include: '**/*.{ts,tsx}',
    exclude: '{**/node_modules/**,**/.git/**,**/dist/**}',
    ignoreCase: true,
    followSymlinks: false,
  };

  try {
    // 3. 查找工作区中符合条件的所有文件
    vscode.window.showInformationMessage('开始扫描工作区文件...');
    const uris = await vscode.workspace.findFiles(fileFindOptions);

    if (uris.length === 0) {
      vscode.window.showInformationMessage('未找到符合条件的文件');
      return allSymbols;
    }

    vscode.window.showInformationMessage(`找到 ${uris.length} 个文件，开始解析符号...`);

    // 4. 遍历每个文件，获取其符号（限制并发数，避免性能问题）
    const concurrencyLimit = 10; // 同时处理的文件数
    let processedCount = 0;

    for (let i = 0; i < uris.length; i += concurrencyLimit) {
      const batch = uris.slice(i, i + concurrencyLimit);
      const batchPromises = batch.map(async (uri) => {
        try {
          // 获取文件的Document对象（确保文件被加载）
          const document = await vscode.workspace.openTextDocument(uri);

          // 调用符号提供者获取文件符号
          const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            uri,
          );

          if (symbols && symbols.length > 0) {
            // 递归处理嵌套符号（如类中的方法、对象中的属性）
            const flattenSymbols = flattenDocumentSymbols(symbols);

            // 整理符号信息
            const filePath = uri.fsPath;
            console.log('filePath', filePath);
            // const fileName = path.basename(filePath);
            // const relativePath = vscode.workspace.asRelativePath(uri);

            flattenSymbols.forEach((symbol) => {
              allSymbols.push(symbol);
            });
          }
        } catch (error) {
          console.error(`解析文件 ${uri.fsPath} 符号失败:`, error);
        } finally {
          processedCount++;
          // 显示进度（可选）
          if (processedCount % 50 === 0) {
            vscode.window.setStatusBarMessage(`已处理 ${processedCount}/${uris.length} 个文件`, 2000);
          }
        }
      });

      // 等待当前批次处理完成
      await Promise.all(batchPromises);
    }

    vscode.window.showInformationMessage(`扫描完成！共获取 ${allSymbols.length} 个符号`);
  } catch (error) {
    vscode.window.showErrorMessage(`获取工作区符号失败: ${(error as Error).message}`);
    console.error('获取符号失败:', error);
  }
  console.log('allSymbols', allSymbols);
  return allSymbols;
}

/**
 * 扁平化DocumentSymbol树（处理嵌套符号）
 * @param symbols DocumentSymbol数组
 * @param parentSymbol 父符号（用于递归）
 * @returns 扁平化后的符号数组
 */
function flattenDocumentSymbols(
  symbols: vscode.DocumentSymbol[],
  parentSymbol?: vscode.DocumentSymbol,
): vscode.DocumentSymbol[] {
  const result: vscode.DocumentSymbol[] = [];

  for (const symbol of symbols) {
    // 记录父符号（可选，便于追踪符号层级）
    (symbol as any).parent = parentSymbol;

    result.push(symbol);

    // 递归处理子符号
    if (symbol.children && symbol.children.length > 0) {
      result.push(...flattenDocumentSymbols(symbol.children, symbol));
    }
  }

  return result;
}

/**
 * 格式化符号信息（便于展示/输出）
 * @param symbolInfo 符号信息
 * @returns 格式化后的字符串
 */
export function formatSymbolInfo(symbolInfo: {
  filePath: string;
  fileName: string;
  relativePath: string;
  symbol: vscode.DocumentSymbol;
}): string {
  const { symbol, relativePath } = symbolInfo;
  const range = symbol.range;

  return [
    `文件: ${relativePath}`,
    `符号: ${symbol.name} (${symbol.kind})`,
    `位置: 行 ${range.start.line + 1}, 列 ${range.start.character + 1}`,
    `描述: ${symbol.detail || '无'}`,
    `----------`,
  ].join('\n');
}

/**
 * 统计属性引用次数
 * @param constObjects as const声明的对象列表
 * @param filePath 当前文件路径
 * @returns 引用统计结果
 */
async function countPropertyReferences(
  constObjects: Array<{ objectName: string; properties: any[]; range?: vscode.Range[] }>,
  filePath: string,
  document: vscode.TextDocument,
): Promise<IRefCounts[]> {
  const result: IRefCounts[] = [];

  // 初始化统计
  constObjects.forEach((obj: any) => {
    // obj.properties.forEach((prop, i) => {
    result.push({
      objectName: obj['key'] as string,
      propertyName: obj['key'] as string,
      count: 0,
      range: obj.range,
      location: [],
      key: uKey(),
    });
    // });
  });
  console.log('xxxxx', result);

  const symbols = await getWorkspaceAllSymbols();
  console.log('symbols', symbols);
  if (symbols) {
    // 2. 递归提取所有函数/方法符号（包含类中的方法）
    const functionSymbols: any[] = [];
    for (const symbol of symbols) {
      // 匹配函数（全局函数）或方法（类中的函数）
      // console.log(symbol);
      // console.log(document.getText(symbol.range));
      // ! 获取代码
      const code = document.getText(symbol.range) || '';
      console.log('code', code);
      if (symbol.kind == vscode.SymbolKind.Function && code.includes('t(')) {
        functionSymbols.push(symbol);
      }
    }

    console.log('functionSymbols', functionSymbols);

    // console.log('functionSymbols', functionSymbols);
    for (const func of functionSymbols) {
      // 跳过取消请求
      // if (token.isCancellationRequested) {
      //   break;
      // }

      // 函数名的精准位置（CodeLens显示在函数名上方/行首）
      // func.range 是函数的完整范围，func.selectionRange 是函数名的精准范围
      const funcNameRange = func.selectionRange;
      // CodeLens显示在函数名所在行的最左侧
      const codeLensPosition = new vscode.Position(funcNameRange.start.line, 0);
      const codeLensRange = new vscode.Range(codeLensPosition, codeLensPosition);
      // 4. 生成唯一缓存key（基于函数名的精准位置）
      const cacheKey = `${funcNameRange.start.line}-${funcNameRange.start.character}`;

      // 2. 获取引用次数（带缓存）
      let refCount = 0;
      // console.log('startPos', match.index, startPos, range);
      try {
        // refCount = await this.getReferenceCount(document, funcNameRange.start, cacheKey);
      } catch (e) {
        // console.error('获取引用失败:', e);
        refCount = -1;
      }

      // 3. 构建 CodeLens
      const codeLens = new vscode.CodeLens(codeLensRange);
      codeLens.command = {
        title: refCount === -1 ? '' : `${refCount} 个引用`,
        command: 'editor.action.findReferences',
        arguments: [document.uri, funcNameRange.start], // 点击跳转到引用列表
        // tooltip: '点击查看引用列表, as const lens',
      };
      // codeLenses.push(codeLens);
    }
  }

  // 获取工作区中所有TS/TSX文件
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
  if (!workspaceFolder) {
    return result;
  }

  const files = await vscode.workspace.findFiles('**/*.{ts,tsx}', '{**/node_modules/**,**/.git/**,**/dist/**}');

  // 遍历每个文件统计引用
  for (const fileUri of files) {
    const document = await vscode.workspace.openTextDocument(fileUri);
    const code = document.getText();
    const sourceFile = createSourceFile(document.fileName, code, ScriptTarget.Latest, true);

    // 遍历AST查找属性访问
    function visitNode(node: Node) {
      // 匹配：TestObj.A 这种属性访问
      if (isPropertyAccessExpression(node)) {
        const objectName = node.expression.getText();
        const propertyName = node.name.getText();

        // 检查是否是目标对象的属性
        const target = result.find((item) => item.objectName === objectName && item.propertyName === propertyName);

        if (target) {
          target.count++;
          // 获取节点起始位置的行列
          const startPos = document.positionAt(node.getStart());
          // 获取节点结束位置的行列
          // const endPos = document.positionAt(node.getEnd());
          // console.log(startPos, startPos.line, startPos.character);
          target.location?.push({
            name: `${objectName}.${propertyName}`,
            filePath: sourceFile.fileName,
            relativePath: vscode.workspace.asRelativePath(sourceFile.fileName),
            uri: vscode.Uri.file(sourceFile.fileName),
            range: new vscode.Range(document.positionAt(node.getStart()), document.positionAt(node.getEnd())),
            line: startPos.line, // VSCode行号从1开始
            column: startPos.character + objectName.length, // 列号从1开始
            key: uKey(),
          });
        }
      }

      forEachChild(node, visitNode);
    }

    visitNode(sourceFile);
  }

  return result;
}

export function deactivate() {
  // 销毁装饰器，避免内存泄漏
  if (decorationType) {
    decorationType.dispose();
  }
}
