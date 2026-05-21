import React, { useState } from 'react';

const ROWS = [
  ['tiny',           '~75 MB',  '極快',  '一般',          '快速試跑。中文常誤判專有名詞。' ],
  ['base',           '~140 MB', '快',    '普通',          '比 tiny 顯著進步，仍偏快。' ],
  ['small',          '~460 MB', '中等',  '中上',          '長片預跑 / 預覽用，多數情境堪用。' ],
  ['medium',         '~1.5 GB', '較慢',  '高',            '中文人聲普遍可用，準確/速度平衡。' ],
  ['large-v3-turbo', '~1.6 GB', '快 ★ 推薦', '接近 large-v3', 'Whisper Turbo：速度約 large-v3 的 5–8 倍，準確度幾乎沒差。M 系列 + MLX 上最划算。' ],
  ['large-v3',       '~3 GB',   '慢',    '最高',          '中文 / 重口音 / 雜訊最佳，但 turbo 多數情境已夠。' ]
];

export default function ModelHelp() {
  const [open, setOpen] = useState(false);
  return (
    <span className="model-help">
      <button type="button" className="hint-btn" onClick={() => setOpen((o) => !o)} title="模型說明">?</button>
      {open && (
        <div className="hint-pop" onMouseLeave={() => setOpen(false)}>
          <div className="hint-title">faster-whisper 模型 — 大小 vs 準確度</div>
          <table>
            <thead><tr><th>模型</th><th>大小</th><th>速度</th><th>準確度</th><th>適用</th></tr></thead>
            <tbody>{ROWS.map(([m, s, sp, a, note]) => (
              <tr key={m}><td><code>{m}</code></td><td>{s}</td><td>{sp}</td><td>{a}</td><td>{note}</td></tr>
            ))}</tbody>
          </table>
          <p className="muted">第一次使用某模型會自動下載權重到 <code>~/.cache/huggingface</code>。Apple Silicon（M 系列）會自動用 <b>mlx-whisper</b>（Neural Engine + Metal），速度約是 faster-whisper CPU 的 3–8 倍。其他平台 fallback 到 faster-whisper。</p>
          <p className="muted">日常建議用 <b>large-v3-turbo</b>（兼顧速度與品質）。「任務 → 翻譯成英文」會強制輸出英文（不論原語言）。</p>
        </div>
      )}
    </span>
  );
}
