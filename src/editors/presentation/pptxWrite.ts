import { zipSync, strToU8 } from 'fflate';
import { EMU, MIME_BY_EXT, isLine, type Deck, type El, type Para, type Run, type Slide, type Style } from './model';

// Deck → .pptx. Writes a minimal but complete OOXML package (one master, one
// layout, theme, notes master) with every run/fill fully explicit so the
// result doesn't depend on master styles.

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument';

const esc = (s: string): string =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const emu = (px: number): number => Math.round(px * EMU);
const hex = (c: string): string => (/^[0-9A-F]{6}$/i.test(c) ? c.toUpperCase() : '000000');
const lock = (el: El): string => (el.locked ? ' descr="genz:master"' : '');
const solid = (c: string): string => `<a:solidFill><a:srgbClr val="${hex(c)}"/></a:solidFill>`;

function rels(list: [string, string, string][]): string {
  return `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.includes('://') ? type : `${REL}/${type}`}" Target="${target}"/>`).join('')
  }</Relationships>`;
}

const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const xfrm = (el: Pick<El, 'x' | 'y' | 'w' | 'h'> & Partial<El>, tag = 'a:xfrm'): string =>
  `<${tag}${el.rot ? ` rot="${Math.round(el.rot * 60000)}"` : ''}${el.flipH ? ' flipH="1"' : ''}${el.flipV ? ' flipV="1"' : ''}><a:off x="${emu(el.x)}" y="${emu(el.y)}"/><a:ext cx="${Math.max(0, emu(el.w))}" cy="${Math.max(0, emu(el.h))}"/></${tag}>`;

function rPr(s: Style, tag = 'a:rPr'): string {
  return `<${tag} lang="en-US" sz="${Math.max(100, Math.round(s.sz * 100))}"${s.b ? ' b="1"' : ' b="0"'}${s.i ? ' i="1"' : ''}${s.u ? ' u="sng"' : ''} dirty="0">${solid(s.color)}<a:latin typeface="${esc(s.font)}"/></${tag}>`;
}
function runXml(r: Run): string {
  return r.text.split('\n').map((t) => (t ? `<a:r>${rPr(r)}<a:t>${esc(t)}</a:t></a:r>` : '')).join(`<a:br>${rPr(r)}</a:br>`);
}
function paraXml(p: Para): string {
  const marL = p.lvl * 457200 + (p.bu ? 342900 : 0);
  const bullet = !p.bu ? '<a:buNone/>'
    : p.bu === 'num' ? '<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>'
      : `<a:buFont typeface="Arial"/><a:buChar char="${esc(p.bu)}"/>`;
  return `<a:p><a:pPr marL="${marL}" indent="${p.bu ? -342900 : 0}"${p.lvl ? ` lvl="${p.lvl}"` : ''} algn="${p.algn}">${bullet}</a:pPr>${
    p.runs.map(runXml).join('')}${rPr(p.def, 'a:endParaRPr')}</a:p>`;
}

function spXml(el: El, id: number): string {
  const ph = el.ph === 'title' || el.ph === 'ctrTitle' ? '<p:ph type="title"/>' : '';
  const anchor = el.anchor;
  const fill = el.fill ? solid(el.fill) : '<a:noFill/>';
  const ln = el.line ? `<a:ln w="${emu(el.lineW)}">${solid(el.line)}</a:ln>` : '<a:ln><a:noFill/></a:ln>';
  const body = isLine(el.geom) ? '' : `<p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="${anchor}"><a:noAutofit/></a:bodyPr><a:lstStyle/>${
    el.paras.length ? el.paras.map(paraXml).join('') : '<a:p><a:endParaRPr lang="en-US"/></a:p>'}</p:txBody>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${ph ? 'Title' : 'Shape'} ${id}"${lock(el)}/><p:cNvSpPr${ph ? '><a:spLocks noGrp="1"/></p:cNvSpPr>' : el.fill || el.line ? '/>' : ' txBox="1"/>'}<p:nvPr>${ph}</p:nvPr></p:nvSpPr>`
    + `<p:spPr>${xfrm(el)}<a:prstGeom prst="${isLine(el.geom) ? 'line' : esc(el.geom)}"><a:avLst/></a:prstGeom>${isLine(el.geom) ? '' : fill}${ln}</p:spPr>${body}</p:sp>`;
}

function picXml(el: El, id: number, rId: string): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"${lock(el)}/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
    + `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(el)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function tblXml(el: El, id: number): string {
  const nCols = Math.max(1, ...el.rows.map((r) => r.length));
  const cols = Array.from({ length: nCols }, (_, i) => el.cols[i] ?? el.w / nCols);
  const rowH = el.h / Math.max(1, el.rows.length);
  const border = ['lnL', 'lnR', 'lnT', 'lnB'].map((t) => `<a:${t} w="12700">${solid('8C8C8C')}</a:${t}>`).join('');
  const cell = (t: string): string => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${
    t.split('\n').map((line) => `<a:p>${line ? `<a:r>${rPr(el.cell)}<a:t>${esc(line)}</a:t></a:r>` : ''}${rPr(el.cell, 'a:endParaRPr')}</a:p>`).join('')
  }</a:txBody><a:tcPr>${border}</a:tcPr></a:tc>`;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"${lock(el)}/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>${xfrm({ x: el.x, y: el.y, w: el.w, h: el.h }, 'p:xfrm')}`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${
      cols.map((w) => `<a:gridCol w="${emu(w)}"/>`).join('')}</a:tblGrid>${
      el.rows.map((r) => `<a:tr h="${emu(rowH)}">${Array.from({ length: nCols }, (_, i) => cell(r[i] ?? '')).join('')}</a:tr>`).join('')
    }</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

const THEME = `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements>`
  + '<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
  + '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>'
  + '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>'
  + '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>'
  + '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
  + `<a:fmtScheme name="Office"><a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst>`
  + `<a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`).join('')}</a:lnStyleLst>`
  + `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>`
  + `<a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst></a:fmtScheme>`
  + '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

const CLRMAP = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';
const phSp = (id: number, name: string, ph: string, box: string, body = true): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${box}</p:spPr>${
    body ? '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>' : ''}</p:sp>`;
const box = (x: number, y: number, w: number, h: number): string =>
  `<a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`;
const lvl1 = (sz: number, font: string, extra = ''): string =>
  `<a:lvl1pPr${extra}><a:defRPr sz="${sz}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="${font}"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr>`;

function masterXml(cx: number, cy: number): string {
  const m = cx * 0.0625;
  return `${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}`
    + phSp(2, 'Title Placeholder 1', '<p:ph type="title"/>', box(m, cy * 0.05, cx - 2 * m, cy * 0.2))
    + phSp(3, 'Text Placeholder 2', '<p:ph type="body" idx="1"/>', box(m, cy * 0.28, cx - 2 * m, cy * 0.65))
    + `</p:spTree></p:cSld><p:clrMap ${CLRMAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>`
    + `<p:txStyles><p:titleStyle>${lvl1(4400, '+mj-lt', ' algn="l"')}</p:titleStyle>`
    + `<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="2800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:bodyStyle>`
    + `<p:otherStyle>${lvl1(1800, '+mn-lt')}</p:otherStyle></p:txStyles></p:sldMaster>`;
}
const LAYOUT = `${HEAD}<p:sldLayout ${NS} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${GRP}`
  + phSp(2, 'Title 1', '<p:ph type="title"/>', '') + phSp(3, 'Content Placeholder 2', '<p:ph idx="1"/>', '')
  + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
const NOTES_MASTER = `${HEAD}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}`
  + phSp(2, 'Slide Image Placeholder 1', '<p:ph type="sldImg" idx="2"/>', box(685800, 1143000, 5486400, 3086100), false)
  + phSp(3, 'Notes Placeholder 2', '<p:ph type="body" sz="quarter" idx="3"/>', box(685800, 4400550, 5486400, 3600450))
  + `</p:spTree></p:cSld><p:clrMap ${CLRMAP}/></p:notesMaster>`;

function notesXml(text: string): string {
  const ps = text.split('\n').map((l) => `<a:p>${l ? `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(l)}</a:t></a:r>` : ''}</a:p>`).join('');
  return `${HEAD}<p:notes ${NS}><p:cSld><p:spTree>${GRP}`
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${ps}</p:txBody></p:sp>`
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';
}

export function writePptx(deck: Deck, title: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const put = (p: string, s: string): void => { files[p] = strToU8(s); };
  const cx = emu(deck.w), cy = emu(deck.h);
  const mediaPath = new Map<string, string>();
  const exts = new Set<string>();
  const overrides: [string, string][] = [];
  const mediaFor = (key: string): string | null => {
    const m = deck.media[key];
    if (!m) return null;
    let p = mediaPath.get(key);
    if (!p) {
      p = `media/image${mediaPath.size + 1}.${m.ext}`;
      mediaPath.set(key, p);
      files[`ppt/${p}`] = m.data;
      exts.add(m.ext);
    }
    return `../${p}`;
  };

  deck.slides.forEach((s: Slide, i) => {
    const n = i + 1;
    const rl: [string, string, string][] = [['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']];
    const addRel = (type: string, target: string): string => { const id = `rId${rl.length + 1}`; rl.push([id, type, target]); return id; };
    let bg = '';
    const bgImg = s.bgMedia ? mediaFor(s.bgMedia) : null;
    if (bgImg) bg = `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${addRel('image', bgImg)}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
    else if (s.bg) bg = `<p:bg><p:bgPr>${solid(s.bg)}<a:effectLst/></p:bgPr></p:bg>`;
    let id = 2;
    const shapes = s.els.map((el) => {
      if (el.type === 'pic') {
        const target = mediaFor(el.media);
        return target ? picXml(el, id++, addRel('image', target)) : '';
      }
      if (el.type === 'tbl') return tblXml(el, id++);
      return spXml(el, id++);
    }).join('');
    if (s.notes.trim()) {
      put(`ppt/notesSlides/notesSlide${n}.xml`, notesXml(s.notes));
      put(`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, rels([['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'], ['rId2', 'slide', `../slides/slide${n}.xml`]]));
      overrides.push([`/ppt/notesSlides/notesSlide${n}.xml`, `${CT}.presentationml.notesSlide+xml`]);
      addRel('notesSlide', `../notesSlides/notesSlide${n}.xml`);
    }
    put(`ppt/slides/slide${n}.xml`, `${HEAD}<p:sld ${NS}><p:cSld>${bg}<p:spTree>${GRP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    put(`ppt/slides/_rels/slide${n}.xml.rels`, rels(rl));
    overrides.push([`/ppt/slides/slide${n}.xml`, `${CT}.presentationml.slide+xml`]);
  });

  const nSlides = deck.slides.length;
  const presRels: [string, string, string][] = [
    ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'theme', 'theme/theme1.xml'],
    ['rId3', 'presProps', 'presProps.xml'], ['rId4', 'viewProps', 'viewProps.xml'],
    ['rId5', 'tableStyles', 'tableStyles.xml'], ['rId6', 'notesMaster', 'notesMasters/notesMaster1.xml'],
    ...deck.slides.map((_, i): [string, string, string] => [`rId${i + 7}`, 'slide', `slides/slide${i + 1}.xml`]),
  ];
  put('ppt/presentation.xml', `${HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>`
    + '<p:notesMasterIdLst><p:notesMasterId r:id="rId6"/></p:notesMasterIdLst>'
    + `<p:sldIdLst>${deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 7}"/>`).join('')}</p:sldIdLst>`
    + `<p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  put('ppt/_rels/presentation.xml.rels', rels(presRels));
  put('ppt/slideMasters/slideMaster1.xml', masterXml(cx, cy));
  put('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]));
  put('ppt/slideLayouts/slideLayout1.xml', LAYOUT);
  put('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));
  put('ppt/notesMasters/notesMaster1.xml', NOTES_MASTER);
  put('ppt/notesMasters/_rels/notesMaster1.xml.rels', rels([['rId1', 'theme', '../theme/theme2.xml']]));
  put('ppt/theme/theme1.xml', THEME);
  put('ppt/theme/theme2.xml', THEME);
  put('ppt/presProps.xml', `${HEAD}<p:presentationPr ${NS}/>`);
  put('ppt/viewProps.xml', `${HEAD}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`);
  put('ppt/tableStyles.xml', `${HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  put('docProps/core.xml', `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${esc(title)}</dc:title><dc:creator>GenZ Editor</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  put('docProps/app.xml', `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>GenZ Editor</Application><Slides>${nSlides}</Slides></Properties>`);
  put('_rels/.rels', rels([
    ['rId1', 'officeDocument', 'ppt/presentation.xml'],
    ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
    ['rId3', 'extended-properties', 'docProps/app.xml'],
  ]));

  const pml = `${CT}.presentationml`;
  const ct = [
    ...['rels:application/vnd.openxmlformats-package.relationships+xml', 'xml:application/xml'].map((d) => d.split(':') as [string, string]),
    ...[...exts].map((e): [string, string] => [e, MIME_BY_EXT[e] ?? 'application/octet-stream']),
  ].map(([e, t]) => `<Default Extension="${esc(e)}" ContentType="${t}"/>`).join('');
  const ov: [string, string][] = [
    ['/ppt/presentation.xml', `${pml}.presentation.main+xml`],
    ['/ppt/slideMasters/slideMaster1.xml', `${pml}.slideMaster+xml`],
    ['/ppt/slideLayouts/slideLayout1.xml', `${pml}.slideLayout+xml`],
    ['/ppt/notesMasters/notesMaster1.xml', `${pml}.notesMaster+xml`],
    ['/ppt/theme/theme1.xml', `${CT}.theme+xml`], ['/ppt/theme/theme2.xml', `${CT}.theme+xml`],
    ['/ppt/presProps.xml', `${pml}.presProps+xml`], ['/ppt/viewProps.xml', `${pml}.viewProps+xml`],
    ['/ppt/tableStyles.xml', `${pml}.tableStyles+xml`],
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
    ['/docProps/app.xml', `${CT}.extended-properties+xml`],
    ...overrides,
  ];
  put('[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${ct}${
    ov.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('')}</Types>`);

  return zipSync(files, { level: 6 });
}
