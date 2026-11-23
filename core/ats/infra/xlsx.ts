/**
 * Minimal .xlsx writer (one sheet, right-to-left, bold frozen header, column widths).
 * Pure: works in the browser and in Node. Uses fflate for the zip container.
 */
import { strToU8, zipSync } from 'fflate';

const esc = (s: string) =>
      s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            // characters not allowed in XML 1.0
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const colName = (i: number) => {
      let s = '';
      for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
            s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
      return s;
};

export function buildXlsx(
      sheetName: string,
      columns: string[],
      rows: (string | number | null | undefined)[][],
): Uint8Array {
      const name = (sheetName.replace(/[\[\]:*?/\\]/g, ' ').trim() || 'Sheet1').slice(0, 31);
      const all = [columns, ...rows];
      const widths = columns.map((_, c) =>
            Math.min(60, Math.max(8, ...all.map((r) => String(r[c] ?? '').length + 2))),
      );

      const cellXml = (v: string | number | null | undefined, ref: string, header: boolean) => {
            const style = header ? ' s="1"' : '';
            if (typeof v === 'number' && Number.isFinite(v))
                  return `<c r="${ref}"${style}><v>${v}</v></c>`;
            const text = v == null ? '' : String(v);
            if (!text) return `<c r="${ref}"${style}/>`;
            return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
      };
      const sheetRows = all
            .map(
                  (r, ri) =>
                        `<row r="${ri + 1}">${columns.map((_, ci) => cellXml(r[ci], `${colName(ci)}${ri + 1}`, ri === 0)).join('')}</row>`,
            )
            .join('');

      const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${sheetRows}</sheetData>
</worksheet>`;

      const files: Record<string, Uint8Array> = {
            '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
            '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
            'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(name)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`),
            'xl/_rels/workbook.xml.rels':
                  strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
            'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Tahoma"/></font><font><b/><sz val="11"/><name val="Tahoma"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDF3F0"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`),
            'xl/worksheets/sheet1.xml': strToU8(sheet),
      };
      return zipSync(files, { level: 6 });
}

/** Browser: save the workbook as a download. */
export function downloadXlsx(
      filename: string,
      columns: string[],
      rows: (string | number | null | undefined)[][],
) {
      const data = buildXlsx(filename, columns, rows);
      const blob = new Blob([new Uint8Array(data)], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`).replace(
            /[\\/:*?"<>|]+/g,
            ' ',
      );
      // must be in the document, otherwise some browsers ignore the file name
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
