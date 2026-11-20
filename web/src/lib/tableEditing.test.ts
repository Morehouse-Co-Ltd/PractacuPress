import { afterEach, describe, expect, it } from 'vitest';
import { htmlToMarkdown } from './htmlToMarkdown';
import { renderMarkdown, sanitizeHtml } from './markdown';
import {
  deleteCurrentColumn,
  deleteCurrentRow,
  deleteTable,
  findCell,
  findTable,
  insertColumnLeft,
  insertColumnRight,
  insertRowAbove,
  insertRowBelow,
  isLayoutTable,
  setCellAlign,
  TABLE_ALIGN_CLASSES,
  tableCapabilities,
  tableContextAt,
  toggleHeader,
} from './tableEditing';

/**
 * 表格结构编辑的单测。
 *
 * 全部用 happy-dom 构造真实表格（vitest 的环境已经是 happy-dom），不 mock DOM：
 * 这些函数的合同就是「对浏览器 DOM 做正确的结构修改」，mock 掉 DOM 等于没测。
 */

const PLAIN_TABLE =
  '<table class="pp-table"><tbody>' +
  '<tr><td>A1</td><td>B1</td></tr>' +
  '<tr><td>A2</td><td>B2</td></tr>' +
  '</tbody></table>';

const HEADER_TABLE =
  '<table class="pp-table"><thead><tr><th>H1</th><th>H2</th></tr></thead>' +
  '<tbody><tr><td>A1</td><td>B1</td></tr></tbody></table>';

function mount(html: string): HTMLDivElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

function cellOf(host: ParentNode, selector: string): HTMLTableCellElement {
  const node = host.querySelector(selector);
  if (!node) throw new Error(`缺少节点：${selector}`);
  return node as HTMLTableCellElement;
}

function tableOf(host: ParentNode): HTMLTableElement {
  const node = host.querySelector('table');
  if (!node) throw new Error('缺少表格');
  return node;
}

function rowTexts(table: HTMLTableElement): string[] {
  return Array.from(table.querySelectorAll('tr')).map((row) =>
    Array.from(row.children)
      .map((cell) => (cell.textContent ?? '').trim())
      .join('|'),
  );
}

function columnTexts(table: HTMLTableElement): string[][] {
  return Array.from(table.querySelectorAll('tr')).map((row) =>
    Array.from(row.children).map((cell) => (cell.textContent ?? '').trim()),
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('findCell / findTable', () => {
  it('从文本节点与内层元素都能找到所在单元格与表格', () => {
    const host = mount(PLAIN_TABLE.replace('<td>B1</td>', '<td><strong id="deep">B1</strong></td>'));
    const td = cellOf(host, 'td');
    const table = tableOf(host);

    expect(findCell(td.firstChild)).toBe(td);
    expect(findCell(td)).toBe(td);
    expect(findCell(host.querySelector('#deep'))).toBe(cellOf(host, 'td:nth-child(2)'));
    expect(findTable(td)).toBe(table);
    expect(findTable(table)).toBe(table);
    expect(findTable(host.querySelector('#deep'))).toBe(table);
  });

  it('表格外面、null 与其它块都返回 null', () => {
    const host = mount(`${PLAIN_TABLE}<p id="outside">正文</p>`);
    expect(findCell(host.querySelector('#outside'))).toBeNull();
    expect(findTable(host.querySelector('#outside'))).toBeNull();
    expect(findCell(null)).toBeNull();
    expect(findTable(null)).toBeNull();
  });

  it('嵌套表格取最内层', () => {
    const host = mount(
      '<table class="pp-table"><tbody><tr><td>外层' +
        '<table class="pp-table"><tbody><tr><td id="inner">内层</td></tr></tbody></table>' +
        '</td></tr></tbody></table>',
    );
    const inner = cellOf(host, '#inner');
    const tables = host.querySelectorAll('table');
    expect(findCell(inner)).toBe(inner);
    expect(findTable(inner)).toBe(tables[1]);
    expect(findTable(inner)?.contains(tables[1])).toBe(true);
  });
});

describe('tableContextAt / tableCapabilities', () => {
  it('返回表格、单元格与按钮状态', () => {
    const host = mount(HEADER_TABLE);
    const cell = cellOf(host, 'tbody td');
    const context = tableContextAt(cell);
    expect(context?.table).toBe(tableOf(host));
    expect(context?.cell).toBe(cell);
    expect(context?.capabilities).toMatchObject({
      rowCount: 2,
      columnCount: 2,
      hasHeader: true,
      hasMergedCells: false,
      align: null,
      canInsertRow: true,
      canInsertColumn: true,
      canDeleteRow: true,
      canDeleteColumn: true,
      canToggleHeader: true,
    });
  });

  it('没有光标单元格时返回 null', () => {
    const host = mount(PLAIN_TABLE);
    expect(tableContextAt(host.querySelector('table'))).toBeNull();
    expect(tableContextAt(null)).toBeNull();
    expect(tableCapabilities(tableOf(host), null)).toBeNull();
    expect(tableCapabilities(null, cellOf(host, 'td'))).toBeNull();
  });

  it('单行 / 单列时禁用删除；空表禁用结构操作', () => {
    const singleRow = mount('<table class="pp-table"><tbody><tr><td>A</td><td>B</td></tr></tbody></table>');
    expect(tableCapabilities(tableOf(singleRow), cellOf(singleRow, 'td'))).toMatchObject({
      canDeleteRow: false,
      canDeleteColumn: true,
    });

    const singleColumn = mount(
      '<table class="pp-table"><tbody><tr><td>A</td></tr><tr><td>B</td></tr></tbody></table>',
    );
    expect(tableCapabilities(tableOf(singleColumn), cellOf(singleColumn, 'td'))).toMatchObject({
      canDeleteRow: true,
      canDeleteColumn: false,
    });

    const empty = mount('<table class="pp-table"><tbody></tbody></table>');
    expect(tableCapabilities(tableOf(empty), null)).toBeNull();
    expect(insertRowAbove(null)).toBeNull();
    expect(insertRowBelow(null)).toBeNull();
    expect(insertColumnLeft(null)).toBeNull();
    expect(insertColumnRight(null)).toBeNull();
    expect(deleteCurrentRow(null)).toBeNull();
    expect(deleteCurrentColumn(null)).toBeNull();
    expect(toggleHeader(null)).toBeNull();
    expect(setCellAlign(null, 'center')).toBeNull();
    expect(deleteTable(null)).toBe(false);
  });

  it('合并单元格让增删行列不可用，但切换表头与对齐仍可用', () => {
    const host = mount(
      '<table class="pp-table"><tbody>' +
        '<tr><td colspan="2">合并</td></tr>' +
        '<tr><td>A</td><td>B</td></tr>' +
        '</tbody></table>',
    );
    const cell = cellOf(host, 'tr:nth-child(2) td');
    const capabilities = tableCapabilities(tableOf(host), cell);
    expect(capabilities?.hasMergedCells).toBe(true);
    expect(capabilities?.canInsertRow).toBe(false);
    expect(capabilities?.canInsertColumn).toBe(false);
    expect(capabilities?.canDeleteRow).toBe(false);
    expect(capabilities?.canDeleteColumn).toBe(false);
    expect(capabilities?.canToggleHeader).toBe(true);
    expect(setCellAlign(cell, 'right')).toBe(cell);
  });

  it('分栏 / 图集标记为布局表格', () => {
    const host = mount('<table class="pp-columns"><tbody><tr><td>A</td></tr></tbody></table>');
    expect(isLayoutTable(tableOf(host))).toBe(true);
    expect(isLayoutTable(null)).toBe(false);
    expect(isLayoutTable(host.querySelector('table') as HTMLTableElement)).toBe(true);
  });
});

describe('插入行', () => {
  it('上方插入：新行插在当前行前，光标留在原单元格', () => {
    const host = mount(PLAIN_TABLE);
    const cell = cellOf(host, 'tbody tr:nth-child(2) td');
    const focus = insertRowAbove(cell);
    const table = tableOf(host);

    expect(focus).toBe(cell);
    expect(cell.isConnected).toBe(true);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(rowTexts(table)).toEqual(['A1|B1', '|', 'A2|B2']);
    const inserted = table.querySelectorAll('tbody tr')[1] as HTMLTableRowElement;
    expect(Array.from(inserted.cells).map((item) => item.tagName)).toEqual(['TD', 'TD']);
    expect(inserted.textContent).toBe('');
  });

  it('下方插入：新行插在当前行后', () => {
    const host = mount(PLAIN_TABLE);
    const cell = cellOf(host, 'tbody tr:first-child td');
    expect(insertRowBelow(cell)).toBe(cell);
    const table = tableOf(host);
    expect(rowTexts(table)).toEqual(['A1|B1', '|', 'A2|B2']);
  });

  it('表头最后一行下方插入的是正文行（td，进 tbody）', () => {
    const host = mount(HEADER_TABLE);
    const headerCell = cellOf(host, 'thead th');
    expect(insertRowBelow(headerCell)).toBe(headerCell);
    const table = tableOf(host);

    expect(table.querySelectorAll('thead tr')).toHaveLength(1);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table.querySelectorAll('tbody tr')[0]?.querySelector('td')).not.toBeNull();
    expect(table.querySelectorAll('tbody tr')[0]?.querySelector('th')).toBeNull();
  });

  it('只有表头时：下方插行会创建 tbody，上方插行仍是表头行', () => {
    const host = mount(
      '<table class="pp-table"><thead><tr><th>H1</th><th>H2</th></tr></thead></table>',
    );
    const headerCell = cellOf(host, 'th');
    expect(insertRowBelow(headerCell)).toBe(headerCell);
    const table = tableOf(host);
    expect(table.querySelectorAll('thead tr')).toHaveLength(1);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(table.querySelectorAll('tbody td')).toHaveLength(2);

    expect(insertRowAbove(headerCell)).toBe(headerCell);
    expect(table.querySelectorAll('thead tr')).toHaveLength(2);
    expect(table.querySelectorAll('thead th')).toHaveLength(4);
  });

  it('空表、合并单元格与空行安全拒绝', () => {
    const empty = mount('<table class="pp-table"><tbody></tbody></table>');
    expect(insertRowAbove(cellOf(empty, 'tbody') as unknown as HTMLTableCellElement)).toBeNull();
    expect(insertRowBelow(null)).toBeNull();

    const merged = mount(
      '<table class="pp-table"><tbody><tr><td colspan="2">合并</td></tr><tr><td>A</td><td>B</td></tr></tbody></table>',
    );
    expect(insertRowAbove(cellOf(merged, 'tr:nth-child(2) td'))).toBeNull();

    const emptyRow = mount('<table class="pp-table"><tbody><tr></tr></tbody></table>');
    expect(insertRowAbove(cellOf(emptyRow, 'tr') as unknown as HTMLTableCellElement)).toBeNull();
  });
});

describe('插入列', () => {
  it('左侧插入：每行都在当前列前加一格，返回原单元格', () => {
    const host = mount(PLAIN_TABLE);
    const cell = cellOf(host, 'tbody tr:first-child td:nth-child(2)');
    expect(insertColumnLeft(cell)).toBe(cell);
    const table = tableOf(host);

    expect(columnTexts(table)).toEqual([
      ['A1', '', 'B1'],
      ['A2', '', 'B2'],
    ]);
    expect(Array.from(cell.parentElement!.children).indexOf(cell)).toBe(2);
  });

  it('右侧插入：表头行补 th、正文行补 td', () => {
    const host = mount(HEADER_TABLE);
    const headerCell = cellOf(host, 'thead th');
    expect(insertColumnRight(headerCell)).toBe(headerCell);
    const table = tableOf(host);

    const headerRow = table.querySelectorAll('thead tr')[0] as HTMLTableRowElement;
    const bodyRow = table.querySelectorAll('tbody tr')[0] as HTMLTableRowElement;
    expect(Array.from(headerRow.cells).map((item) => item.tagName)).toEqual([
      'TH',
      'TH',
      'TH',
    ]);
    expect(Array.from(bodyRow.cells).map((item) => item.tagName)).toEqual([
      'TD',
      'TD',
      'TD',
    ]);
  });

  it('合并单元格、空表与嵌套表格边界', () => {
    const merged = mount(
      '<table class="pp-table"><tbody><tr><td colspan="2">合并</td></tr><tr><td>A</td><td>B</td></tr></tbody></table>',
    );
    expect(insertColumnLeft(cellOf(merged, 'tr:nth-child(2) td'))).toBeNull();

    const nested = mount(
      '<table class="pp-table"><tbody><tr><td>A' +
        '<table class="pp-table"><tbody><tr><td>内</td></tr></tbody></table>' +
        '</td><td>B</td></tr></tbody></table>',
    );
    const outer = tableOf(nested);
    const outerCell = cellOf(nested, 'tr:first-child > td');
    expect(insertColumnRight(outerCell)).toBe(outerCell);
    expect(outer.querySelectorAll('tr')[0]?.children).toHaveLength(3);
    // 嵌套表格自己的列不受影响。
    expect(outer.querySelectorAll('table')[0]?.querySelectorAll('tr')[0]?.children).toHaveLength(1);
  });
});

describe('删除行 / 列', () => {
  it('删除当前行，光标回到同一列的相邻行', () => {
    const host = mount(PLAIN_TABLE);
    const cell = cellOf(host, 'tbody tr:first-child td:nth-child(2)');
    const focus = deleteCurrentRow(cell);
    const table = tableOf(host);

    expect(focus?.textContent).toBe('B2');
    expect(focus?.tagName).toBe('TD');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(rowTexts(table)).toEqual(['A2|B2']);
  });

  it('删除最后一行、最后一行表格与合并单元格时不改动 DOM', () => {
    const single = mount('<table class="pp-table"><tbody><tr><td>A</td><td>B</td></tr></tbody></table>');
    expect(deleteCurrentRow(cellOf(single, 'td'))).toBeNull();
    expect(single.querySelectorAll('tr')).toHaveLength(1);

    const merged = mount(
      '<table class="pp-table"><tbody><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></tbody></table>',
    );
    expect(deleteCurrentRow(cellOf(merged, 'tr:last-child td'))).toBeNull();
    expect(merged.querySelectorAll('tr')).toHaveLength(2);
  });

  it('删表头行会顺带收掉空 thead', () => {
    const host = mount(HEADER_TABLE);
    const focus = deleteCurrentRow(cellOf(host, 'thead th'));
    const table = tableOf(host);
    expect(focus?.textContent).toBe('A1');
    expect(table.querySelector('thead')).toBeNull();
    expect(table.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('删除当前列，光标回到同一行的相邻列', () => {
    const host = mount(PLAIN_TABLE);
    const cell = cellOf(host, 'tbody tr:first-child td:nth-child(2)');
    const focus = deleteCurrentColumn(cell);

    expect(focus?.textContent).toBe('A1');
    expect(columnTexts(tableOf(host))).toEqual([['A1'], ['A2']]);
  });

  it('只有一列时拒绝删除列', () => {
    const host = mount(
      '<table class="pp-table"><tbody><tr><td>A</td></tr><tr><td>B</td></tr></tbody></table>',
    );
    const before = host.innerHTML;
    expect(deleteCurrentColumn(cellOf(host, 'td'))).toBeNull();
    expect(host.innerHTML).toBe(before);
  });
});

describe('切换表头', () => {
  it('首行包进 thead 并换成 th，再点一次还原', () => {
    const host = mount(PLAIN_TABLE);
    const table = tableOf(host);
    const original = cellOf(host, 'tbody tr:first-child td:first-child');

    const focused = toggleHeader(original);
    expect(table.querySelector('thead')).not.toBeNull();
    expect(table.querySelectorAll('thead tr')).toHaveLength(1);
    expect(table.querySelectorAll('thead th')).toHaveLength(2);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(focused?.tagName).toBe('TH');
    expect(focused?.textContent).toBe('A1');
    expect(tableCapabilities(table, focused!)?.hasHeader).toBe(true);

    const back = toggleHeader(focused);
    expect(table.querySelector('thead')).toBeNull();
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(back?.tagName).toBe('TD');
    expect(back?.textContent).toBe('A1');
    expect(rowTexts(table)).toEqual(['A1|B1', 'A2|B2']);

    // 重建后的单元格仍然带着原有属性（例如对齐）。
    setCellAlign(back, 'center');
    toggleHeader(back);
    const aligned = cellOf(host, 'thead th');
    expect(CLASSES(aligned)).toContain('pp-align-center');
  });

  it('旧式表头（首行全是 th，没有 thead）可以直接取消', () => {
    const host = mount(
      '<table class="pp-table"><tbody>' +
        '<tr><th>H1</th><th>H2</th></tr>' +
        '<tr><td>A</td><td>B</td></tr>' +
        '</tbody></table>',
    );
    const table = tableOf(host);
    const first = cellOf(host, 'tbody tr:first-child th');
    expect(tableCapabilities(table, first)?.hasHeader).toBe(true);

    const focused = toggleHeader(first);
    expect(focused?.tagName).toBe('TD');
    expect(table.querySelector('thead')).toBeNull();
    expect(table.querySelectorAll('tbody tr:first-child td')).toHaveLength(2);

    const again = toggleHeader(focused);
    expect(table.querySelector('thead')).not.toBeNull();
    expect(again?.tagName).toBe('TH');
  });

  it('空表、没有单元格时不抛异常', () => {
    const host = mount('<table class="pp-table"><tbody></tbody></table>');
    expect(toggleHeader(null)).toBeNull();
    expect(
      toggleHeader(cellOf(host, 'tbody') as unknown as HTMLTableCellElement),
    ).toBeNull();
  });

  it('光标在正文行时切换表头不会移动光标', () => {
    const host = mount(PLAIN_TABLE);
    const bodyCell = cellOf(host, 'tbody tr:nth-child(2) td');
    expect(toggleHeader(bodyCell)).toBe(bodyCell);
    expect(bodyCell.isConnected).toBe(true);
    expect(tableOf(host).querySelector('thead')).not.toBeNull();
  });
});

function CLASSES(cell: Element): string[] {
  return Array.from(cell.classList);
}

describe('单元格对齐', () => {
  it('写 pp-align-* class，替换旧对齐并保留其它 class', () => {
    const host = mount(PLAIN_TABLE);
    const cell = cellOf(host, 'td');
    cell.classList.add('pp-custom');

    expect(setCellAlign(cell, 'center')).toBe(cell);
    expect(CLASSES(cell)).toContain('pp-align-center');
    expect(cell.getAttribute('style')).toBeNull();

    setCellAlign(cell, 'right');
    expect(CLASSES(cell)).toEqual(expect.arrayContaining(['pp-custom', 'pp-align-right']));
    expect(CLASSES(cell).filter((name) => name.startsWith('pp-align-'))).toEqual([
      'pp-align-right',
    ]);

    setCellAlign(cell, 'left');
    expect(CLASSES(cell).filter((name) => name.startsWith('pp-align-'))).toEqual([
      'pp-align-left',
    ]);
  });

  it('非法对齐值、null 与表格外的格子返回 null', () => {
    const host = mount(PLAIN_TABLE);
    const cell = cellOf(host, 'td');
    expect(setCellAlign(cell, 'middle' as never)).toBeNull();
    expect(setCellAlign(null, 'center')).toBeNull();

    const stray = document.createElement('td');
    stray.textContent = 'x';
    expect(setCellAlign(stray, 'center')).toBeNull();
  });

  it('class 常量与实现保持一致', () => {
    expect(TABLE_ALIGN_CLASSES).toEqual([
      'pp-align-left',
      'pp-align-center',
      'pp-align-right',
    ]);
  });
});

describe('删除表格', () => {
  it('从文档里移除整张表', () => {
    const host = mount(PLAIN_TABLE);
    const table = tableOf(host);
    expect(deleteTable(table)).toBe(true);
    expect(host.querySelector('table')).toBeNull();
    expect(deleteTable(table)).toBe(false);
    expect(deleteTable(null)).toBe(false);
  });

  it('没有父节点的表格返回 false', () => {
    const detached = document.createElement('table');
    expect(deleteTable(detached)).toBe(false);
  });
});

describe('边界与序列化', () => {
  it('所有操作对 null / 空表都不抛异常', () => {
    const empty = mount('<table class="pp-table"><tbody></tbody></table>');
    const table = tableOf(empty);

    expect(() => {
      insertRowAbove(null);
      insertRowBelow(null);
      insertColumnLeft(null);
      insertColumnRight(null);
      deleteCurrentRow(null);
      deleteCurrentColumn(null);
      toggleHeader(null);
      setCellAlign(null, 'center');
      expect(tableCapabilities(table, null)).toBeNull();
      expect(tableContextAt(null)).toBeNull();
      expect(deleteTable(null)).toBe(false);
    }).not.toThrow();
    expect(empty.querySelectorAll('tr')).toHaveLength(0);
  });

  it('行列操作不会碰到单元格里的嵌套表格', () => {
    const host = mount(
      '<table class="pp-table"><tbody>' +
        '<tr><td>外<table class="pp-table"><tbody><tr><td>内1</td><td>内2</td></tr></tbody></table></td><td>B</td></tr>' +
        '<tr><td>C</td><td>D</td></tr>' +
        '</tbody></table>',
    );
    const table = tableOf(host);
    const outerCell = cellOf(host, 'tr:first-child > td');
    expect(insertColumnRight(outerCell)).toBe(outerCell);
    expect(table.querySelectorAll('tr')[0]?.children).toHaveLength(3);
    const nested = host.querySelectorAll('table')[1] as HTMLTableElement;
    expect(nested.querySelectorAll('tr')[0]?.children).toHaveLength(2);
    expect(nested.querySelectorAll('tr')[0]?.textContent).toContain('内1');
  });

  it('对齐 class 能被 htmlToMarkdown 序列化、客户端清洗与 Markdown 渲染保留', () => {
    const host = mount(PLAIN_TABLE);
    const cell = cellOf(host, 'tbody tr:first-child td:nth-child(2)');
    setCellAlign(cell, 'center');

    const markdown = htmlToMarkdown(host.innerHTML);
    expect(markdown).toContain('class="pp-align-center"');
    expect(markdown).not.toContain('style=');
    // 表格按原始 HTML 区块保存，因此单元格 class 不会在管道语法里丢掉。
    expect(markdown).toContain('<table class="pp-table">');

    const rendered = sanitizeHtml(renderMarkdown(markdown));
    expect(rendered).toContain('pp-align-center');
    expect(rendered).not.toContain('style=');
    // 服务端白名单只保留 class 与 pp- / language- 前缀（见 internal/security/content.go），
    // 这里确认写出去的正是该前缀，客户端清洗也不会删掉它。
    expect(TABLE_ALIGN_CLASSES.every((name) => name.startsWith('pp-'))).toBe(true);
  });
});
