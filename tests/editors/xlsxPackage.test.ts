// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { XlsxPackage, gridFromSheet } from '../../src/editors/xlsxPackage';

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

async function fixture(): Promise<ArrayBuffer> {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>');
  z.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  z.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="${M}" xmlns:r="${R}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/><sheet name="Hidden" sheetId="3" state="hidden" r:id="rId3"/></sheets></workbook>`);
  z.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${R}/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId9" Type="${R}/calcChain" Target="calcChain.xml"/></Relationships>`);
  z.file('xl/calcChain.xml', '<calcChain/>');
  z.file('xl/styles.xml', `<?xml version="1.0"?><styleSheet xmlns="${M}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00%"/></numFmts><fonts count="2"><font><sz val="11"/></font><font><b/><sz val="14"/><color rgb="FFFF0000"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills><borders count="1"><border/></borders><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0"><alignment horizontal="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>`);
  z.file('xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="${M}" xmlns:r="${R}"><dimension ref="A1:C3"/><cols><col min="1" max="1" width="20" customWidth="1"/></cols><sheetData><row r="1" ht="30" customHeight="1"><c r="A1" s="1" t="inlineStr"><is><t>Title</t></is></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2" s="2"><v>0.25</v></c><c r="C2"><f>A2+1</f><v>2</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><drawing r:id="rId1"/></worksheet>`);
  z.file('xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
  z.file('xl/drawings/drawing1.xml', `<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${R}"><xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame><xdr:nvGraphicFramePr/><xdr:graphic><a:graphicData><c:chart r:id="rId1"/></a:graphicData></xdr:graphic></xdr:graphicFrame></xdr:twoCellAnchor></xdr:wsDr>`);
  z.file('xl/drawings/_rels/drawing1.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/chart" Target="../charts/chart1.xml"/></Relationships>`);
  z.file('xl/charts/chart1.xml', '<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Q</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="1"><c:v>B</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="1"><c:v>5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>');
  z.file('xl/worksheets/sheet2.xml', `<?xml version="1.0"?><worksheet xmlns="${M}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>two</t></is></c></row></sheetData></worksheet>`);
  z.file('xl/worksheets/sheet3.xml', `<?xml version="1.0"?><worksheet xmlns="${M}"><sheetData/></worksheet>`);
  return z.generateAsync({ type: 'arraybuffer' });
}

describe('xlsxPackage', () => {
  it('reads merges, styles, sizes, charts and skips hidden sheets', async () => {
    const buf = await fixture();
    const pkg = (await XlsxPackage.load(buf))!;
    expect(pkg).toBeTruthy();
    expect(pkg.hasSheet('Second')).toBe(true);
    expect(pkg.isHidden('Hidden')).toBe(true);
    const meta = await pkg.loadSheet('Data');
    expect(meta.merges).toEqual([{ r1: 0, c1: 0, r2: 0, c2: 2 }]);
    expect(meta.styles.get('0,0')).toBe(1);
    expect(meta.colW.get(0)).toBe(145);
    expect(meta.rowH.get(0)).toBe(40);
    expect(pkg.xf(1)!.css).toContain('background-color:#FFFF00');
    expect(pkg.xf(1)!.css).toContain('font-weight:700');
    expect(pkg.xf(1)!.css).toContain('text-align:center');
    expect(meta.objects).toHaveLength(1);
    expect(meta.objects[0]!.chart).toMatchObject({ type: 'col', title: 'Sales', cats: ['A', 'B'], series: [{ name: 'Q', vals: [3, 5] }] });
  });

  it('round-trips: edits land in the original package, chart/styles/merges survive', async () => {
    const buf = await fixture();
    const pkg = (await XlsxPackage.load(buf))!;
    const wb = XLSX.read(buf, { type: 'array' });
    const { grid, orig } = gridFromSheet(wb.Sheets['Data']!);
    expect(grid[1]![0]).toBe('1');
    const meta = await pkg.loadSheet('Data');
    meta.orig = orig;
    grid[1]![0] = '41'; // edit A2
    grid[3] = ['', 'new text'];
    const second = await pkg.loadSheet('Second');
    const fresh = new (await import('../../src/editors/xlsxPackage')).SheetMeta();
    const out = await pkg.build([
      { name: 'Data', meta, grid, computed: () => '' },
      { name: 'Second', meta: second, grid: [['two']], computed: () => '' },
      { name: 'Sheet3', meta: fresh, grid: [['hi', '=1+2']], computed: (_r, c) => (c === 1 ? '3' : '') },
    ]);
    const z = await JSZip.loadAsync(out);
    expect(z.file('xl/charts/chart1.xml')).toBeTruthy();
    expect(z.file('xl/drawings/drawing1.xml')).toBeTruthy();
    expect(z.file('xl/calcChain.xml')).toBeNull();
    const s1 = await z.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(s1).toContain('<drawing r:id="rId1"/>');
    expect(s1).toContain('<mergeCell ref="A1:C1"/>');
    expect(s1).toContain('<c r="A1" s="1" t="inlineStr">');
    expect(s1).toContain('<c r="A2"><v>41</v></c>');
    expect(s1).toContain('<c r="B2" s="2"><v>0.25</v></c>');
    expect(s1).toContain('<c r="C2"><f>A2+1</f><v>2</v></c>');
    expect(s1).toContain('<row r="1" ht="30" customHeight="1">');
    expect(s1).toContain('new text');
    expect(s1.indexOf('<mergeCells')).toBeLessThan(s1.indexOf('<pageMargins'));
    // New sheet is wired into the workbook.
    const wbXml = await z.file('xl/workbook.xml')!.async('string');
    expect(wbXml).toContain('name="Sheet3"');
    expect(wbXml).toContain('fullCalcOnLoad="1"');
    // Whole thing is still readable by SheetJS, with all sheets.
    const back = XLSX.read(out, { type: 'array' });
    expect(back.SheetNames).toEqual(['Data', 'Second', 'Hidden', 'Sheet3']);
    expect(back.Sheets['Data']!['A2']!.v).toBe(41);
    expect(back.Sheets['Data']!['!merges']).toHaveLength(1);
    expect(back.Sheets['Sheet3']!['B1']!.v).toBe(3);
  });
});
