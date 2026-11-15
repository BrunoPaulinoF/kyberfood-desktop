//! Comanda em MODO GRÁFICO: a comanda vira uma IMAGEM desenhada com uma fonte de verdade
//! (Liberation Sans, licença SIL OFL) e é impressa como bitmap raster ESC/POS (`GS v 0`).
//!
//! POR QUE EXISTE. No modo texto a impressora desenha a comanda com a FONTE DELA — um
//! bitmap fixo de 12x24 pontos que, em boa parte dos modelos, sai estreito, fino e difícil
//! de ler (a lojista do Disk Pizzaiolo mandou a foto ao lado da comanda de outro sistema,
//! desenhada como imagem, e perguntou se "dá para mudar essa fonte"). Como imagem, a fonte
//! é a NOSSA: proporcional, com negrito de verdade e linhas de separação limpas, em qualquer
//! impressora que entenda raster — que é praticamente toda térmica ESC/POS.
//!
//! O que chega aqui é um DOCUMENTO ESTRUTURADO em JSON (blocos: texto alinhado, linha de
//! duas colunas, régua, espaço), montado pelo front (`buildReceiptLayout`, espelhado no
//! app web). O front NÃO manda coordenadas nem fonte — só o conteúdo e o papel de cada
//! bloco; quem decide tamanho, quebra de linha e alinhamento é este módulo. É o que permite
//! ao mesmo documento sair como texto ESC/POS (modo de sempre) ou como imagem.
//!
//! A LARGURA DA IMAGEM É A DA FONTE A: `colunas x 12` pontos (48 colunas = 576 = 80mm,
//! 32 = 384 = 58mm). É a MESMA largura que o modo texto já ocupa na impressora da loja —
//! se as 48 colunas cabem hoje, 576 pontos cabem também. Chutar 80mm em pontos daria imagem
//! cortada à direita (o preço) em modelo com cabeça de 512 pontos.

use ab_glyph::{point, Font, FontRef, Glyph, PxScale, ScaleFont};
use serde::Deserialize;

const FONT_REGULAR: &[u8] = include_bytes!("../fonts/LiberationSans-Regular.ttf");
const FONT_BOLD: &[u8] = include_bytes!("../fonts/LiberationSans-Bold.ttf");

/// Pontos por coluna da Fonte A — a largura que o modo texto já ocupa.
const DOTS_PER_COLUMN: usize = 12;
/// Margem lateral em pontos: a borda do papel é onde a cabeça de impressão falha primeiro.
const SIDE_MARGIN: usize = 8;
/// Espaço mínimo entre a coluna da esquerda e a da direita numa linha de duas colunas.
const COLUMN_GAP: f32 = 14.0;
/// Fator do texto GRANDE (tipo do pedido, número, total) sobre o tamanho base.
const BIG_SCALE: f32 = 1.45;
/// Altura da linha em relação ao tamanho da fonte.
const LINE_HEIGHT: f32 = 1.22;
/// Um nível de recuo (complementos e observações de item), em pontos.
const INDENT_PX: f32 = 18.0;
/// Linhas de imagem por comando `GS v 0`: bandas pequenas cabem na memória de qualquer
/// impressora (é o mesmo fatiamento que o python-escpos usa).
const RASTER_BAND_ROWS: usize = 256;
/// Limiar de tinta: acima disso o pixel do anti-aliasing vira ponto impresso.
const INK_THRESHOLD: u8 = 110;

// ---------------------------------------------------------------------------------------------
// CUPOM FISCAL (DANFE NFC-e): blocos `mono` e `qr`. Só o cupom os usa; a comanda continua com
// `text`/`row`/`rule`/`space`, exatamente como antes.
// ---------------------------------------------------------------------------------------------

/// Largura do desenho da letra do `mono` em relação à célula da coluna. Pouco acima de 1: as
/// letras largas (M, W) encostam na vizinha sem invadir, como na Fonte A da impressora.
const MONO_GLYPH_WIDTH_FACTOR: f32 = 1.12;
/// Altura da letra do `mono` em pontos (a Fonte A tem células de 12x24). `tall` dobra SÓ a altura.
const MONO_GLYPH_HEIGHT_PX: f32 = 24.0;
/// Pontos a mais na haste de cada letra do `mono` (corpo engrossado: legível na térmica gasta).
const MONO_STEM_EXTRA_DOTS: i64 = 1;
/// Zona de silêncio do QR, nos quatro lados: o MAIOR entre 4 módulos (norma do QR), 10% do lado
/// do QR e 3 mm (Manual do DANFE NFC-e, 3.4) — ver `qr_quiet_dots`.
const QR_QUIET_MODULES: usize = 4;
/// 3 mm em pontos de impressora (203 dpi = 8 pontos por mm).
const QR_MIN_QUIET_DOTS: usize = 24;
/// Módulo do QR, em pontos: abaixo de 3 (0,375 mm a 203 dpi) o leitor do celular erra; acima
/// de 5 o QR só gasta bobina (um QR da NFC-e de 49 módulos sai com ~31 mm).
const QR_MIN_MODULE_DOTS: usize = 3;
const QR_MAX_MODULE_DOTS: usize = 5;
/// Lados possíveis de um QR: versão 1 (21 módulos) a 40 (177), de 4 em 4.
const QR_MIN_SIZE: usize = 21;
const QR_MAX_SIZE: usize = 177;

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
}

/// Um bloco do documento. ESPELHA `ReceiptBlock` de src/lib/desktop-print-config.ts.
#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Block {
    Text {
        text: String,
        #[serde(default)]
        align: Align,
        #[serde(default)]
        strong: bool,
        #[serde(default)]
        big: bool,
        #[serde(default)]
        indent: u32,
    },
    Row {
        left: String,
        right: String,
        #[serde(default)]
        strong: bool,
        #[serde(default)]
        indent: u32,
    },
    Rule {
        #[serde(default)]
        double: bool,
    },
    Space,
    /// Linha do CUPOM FISCAL numa GRADE de colunas: um caractere por célula, como o modo texto.
    /// O servidor já quebrou e alinhou o cupom em 32/48 colunas (valores à direita com espaços);
    /// a fonte proporcional do `text` desalinharia essas colunas e requebraria as linhas. Linha
    /// maior que a bobina é ERRO (nunca é cortada nem requebrada aqui). ESPELHA
    /// `FiscalRasterBlock` de kyberfood-desktop/src/fiscal-print.ts.
    Mono {
        text: String,
        #[serde(default)]
        align: Align,
        #[serde(default)]
        strong: bool,
        /// Altura dupla (o destaque do cupom: valor a pagar, homologação, contingência).
        #[serde(default)]
        tall: bool,
    },
    /// QR Code da NFC-e: a MATRIZ vem pronta do front (`qrcode-generator`), uma string de '0'/'1'
    /// por linha. Aqui só se desenha: quadrados de N pontos, com zona de silêncio, dentro da
    /// bobina. Matriz torta ou que não cabe é ERRO — QR ilegível não pode sair como se valesse.
    Qr {
        modules: Vec<String>,
        #[serde(default = "center_align")]
        align: Align,
    },
}

fn center_align() -> Align {
    Align::Center
}

/// Zona de silêncio do QR em pontos: o maior entre 4 módulos, 10% do lado e 3 mm (Manual 3.4).
fn qr_quiet_dots(size: usize, dots: usize) -> usize {
    let side = size * dots;
    (QR_QUIET_MODULES * dots).max((side + 9) / 10).max(QR_MIN_QUIET_DOTS)
}

/// O MAIOR módulo (de 5 a 3 pontos) com que o QR e a zona de silêncio cabem em `avail` pontos.
fn qr_module_dots(size: usize, avail: usize) -> Option<usize> {
    (QR_MIN_MODULE_DOTS..=QR_MAX_MODULE_DOTS)
        .rev()
        .find(|&dots| size * dots + 2 * qr_quiet_dots(size, dots) <= avail)
}

#[derive(Deserialize, Debug)]
pub struct Layout {
    pub blocks: Vec<Block>,
}

/// Bitmap em tons de cinza (0 = papel, 255 = tinta), com altura que cresce conforme se desenha.
pub struct Canvas {
    pub width: usize,
    pub pixels: Vec<u8>,
}

impl Canvas {
    fn new(width: usize) -> Self {
        Canvas { width, pixels: Vec::new() }
    }
    pub fn height(&self) -> usize {
        self.pixels.len() / self.width
    }
    fn ensure_rows(&mut self, rows: usize) {
        let needed = rows * self.width;
        if self.pixels.len() < needed {
            self.pixels.resize(needed, 0);
        }
    }
    fn ink(&mut self, x: i64, y: i64, value: u8) {
        if x < 0 || y < 0 || x as usize >= self.width {
            return;
        }
        let (x, y) = (x as usize, y as usize);
        self.ensure_rows(y + 1);
        let idx = y * self.width + x;
        if self.pixels[idx] < value {
            self.pixels[idx] = value;
        }
    }
    fn fill_rect(&mut self, x0: usize, y0: usize, w: usize, h: usize) {
        for y in y0..y0 + h {
            for x in x0..(x0 + w).min(self.width) {
                self.ink(x as i64, y as i64, 255);
            }
        }
    }
    /// Linhas de 1 bit (MSB primeiro), como o `GS v 0` espera.
    pub fn packed_rows(&self) -> (usize, Vec<Vec<u8>>) {
        let bytes_per_row = (self.width + 7) / 8;
        let rows = (0..self.height())
            .map(|y| {
                let mut row = vec![0u8; bytes_per_row];
                for x in 0..self.width {
                    if self.pixels[y * self.width + x] >= INK_THRESHOLD {
                        row[x / 8] |= 0x80 >> (x % 8);
                    }
                }
                row
            })
            .collect();
        (bytes_per_row, rows)
    }
}

struct Typesetter<'a> {
    regular: FontRef<'a>,
    bold: FontRef<'a>,
    base_px: f32,
}

impl<'a> Typesetter<'a> {
    fn font(&self, strong: bool) -> &FontRef<'a> {
        if strong {
            &self.bold
        } else {
            &self.regular
        }
    }

    fn scale(&self, big: bool) -> PxScale {
        PxScale::from(if big { self.base_px * BIG_SCALE } else { self.base_px })
    }

    /// Largura em pontos de um texto numa fonte/escala.
    fn measure(&self, text: &str, strong: bool, big: bool) -> f32 {
        let font = self.font(strong).as_scaled(self.scale(big));
        let mut width = 0.0f32;
        let mut prev: Option<ab_glyph::GlyphId> = None;
        for ch in text.chars() {
            let id = font.glyph_id(ch);
            if let Some(p) = prev {
                width += font.kern(p, id);
            }
            width += font.h_advance(id);
            prev = Some(id);
        }
        width
    }

    /// Quebra o texto em linhas que cabem em `max_width`. Palavra maior que a linha sai
    /// sozinha (e é cortada na borda) em vez de derrubar a impressão.
    fn wrap(&self, text: &str, max_width: f32, strong: bool, big: bool) -> Vec<String> {
        let words: Vec<&str> = text.split_whitespace().collect();
        if words.is_empty() {
            return vec![String::new()];
        }
        let mut lines = Vec::new();
        let mut current = String::new();
        for word in words {
            let candidate = if current.is_empty() { word.to_string() } else { format!("{current} {word}") };
            if !current.is_empty() && self.measure(&candidate, strong, big) > max_width {
                lines.push(std::mem::take(&mut current));
                current = word.to_string();
            } else {
                current = candidate;
            }
        }
        lines.push(current);
        lines
    }

    fn line_height(&self, big: bool) -> f32 {
        (self.scale(big).y * LINE_HEIGHT).ceil()
    }

    /// Desenha uma linha de texto com a base em `baseline_y`, começando em `x`.
    fn draw(&self, canvas: &mut Canvas, text: &str, x: f32, baseline_y: f32, strong: bool, big: bool) {
        let font = self.font(strong).as_scaled(self.scale(big));
        let mut caret = x;
        let mut prev: Option<ab_glyph::GlyphId> = None;
        for ch in text.chars() {
            let id = font.glyph_id(ch);
            if let Some(p) = prev {
                caret += font.kern(p, id);
            }
            let glyph: Glyph = id.with_scale_and_position(self.scale(big), point(caret, baseline_y));
            if let Some(outline) = font.outline_glyph(glyph) {
                let bounds = outline.px_bounds();
                outline.draw(|gx, gy, coverage| {
                    let value = (coverage * 255.0).round() as u8;
                    if value > 0 {
                        canvas.ink(bounds.min.x as i64 + gx as i64, bounds.min.y as i64 + gy as i64, value);
                    }
                });
            }
            caret += font.h_advance(id);
            prev = Some(id);
        }
    }

    /// Desenha UM caractere centralizado na célula `[cell_left, cell_left + cell)` (bloco
    /// `mono` do cupom fiscal). Escala própria (x e y separados): a letra é estreita e alta como
    /// a Fonte A, então a grade de colunas fica igual à do modo texto.
    ///
    /// HASTE +1 PONTO (`MONO_STEM_EXTRA_DOTS`): cada ponto de tinta também pinta o vizinho da
    /// direita. Na letra estreita a haste sairia com 1 ponto, que some na cabeça de impressão
    /// gasta; com ela o corpo do cupom tem haste de 2 pontos ou mais (teste do `raster-tests`).
    #[allow(clippy::too_many_arguments)]
    fn draw_in_cell(
        &self,
        canvas: &mut Canvas,
        ch: char,
        cell_left: f32,
        cell: f32,
        baseline_y: f32,
        strong: bool,
        scale: PxScale,
    ) {
        let font = self.font(strong);
        let scaled = font.as_scaled(scale);
        let id = scaled.glyph_id(ch);
        let x = cell_left + (cell - scaled.h_advance(id)) / 2.0;
        let glyph: Glyph = id.with_scale_and_position(scale, point(x, baseline_y));
        if let Some(outline) = font.outline_glyph(glyph) {
            let bounds = outline.px_bounds();
            outline.draw(|gx, gy, coverage| {
                let value = (coverage * 255.0).round() as u8;
                if value > 0 {
                    let (px, py) = (bounds.min.x as i64 + gx as i64, bounds.min.y as i64 + gy as i64);
                    for extra in 0..=MONO_STEM_EXTRA_DOTS {
                        canvas.ink(px + extra, py, value);
                    }
                }
            });
        }
    }
}

/// Tamanho base da fonte em pontos de impressora a partir do tamanho configurado no painel
/// (7 = pequena, 9 = normal, 12 = grande, 16 = extragrande — os mesmos valores do modo texto).
///
/// Aqui crescer é seguro: a largura do bitmap é a do PAPEL (`cols * DOTS_PER_COLUMN`) e o
/// texto é quebrado por largura em PIXELS, então uma letra maior cabe menos por linha e a
/// comanda fica mais comprida — nunca mais larga que o papel.
fn base_px_for(font_pt: f64) -> f32 {
    if font_pt <= 7.5 {
        22.0
    } else if font_pt >= 15.0 {
        38.0
    } else if font_pt >= 11.0 {
        30.0
    } else {
        26.0
    }
}

/// Desenha o documento inteiro num bitmap com a largura das colunas configuradas.
pub fn render_layout(layout: &Layout, width_cols: i32, font_pt: f64) -> Result<Canvas, String> {
    let cols = if width_cols == 32 { 32 } else { 48 };
    let width = cols * DOTS_PER_COLUMN;
    let regular = FontRef::try_from_slice(FONT_REGULAR).map_err(|e| format!("fonte regular: {e}"))?;
    let bold = FontRef::try_from_slice(FONT_BOLD).map_err(|e| format!("fonte negrito: {e}"))?;
    let ts = Typesetter { regular, bold, base_px: base_px_for(font_pt) };

    let mut canvas = Canvas::new(width);
    let content_left = SIDE_MARGIN as f32;
    let content_width = (width - 2 * SIDE_MARGIN) as f32;
    let mut y = 0.0f32;

    for block in &layout.blocks {
        match block {
            Block::Text { text, align, strong, big, indent } => {
                let indent_px = *indent as f32 * INDENT_PX;
                let avail = content_width - indent_px;
                let lh = ts.line_height(*big);
                let ascent = ts.font(*strong).as_scaled(ts.scale(*big)).ascent();
                for (i, line) in ts.wrap(text, avail, *strong, *big).into_iter().enumerate() {
                    let w = ts.measure(&line, *strong, *big);
                    // Continuação de linha quebrada ganha recuo: ela fica visivelmente presa à
                    // linha de cima. É o que impede um nome de cliente forjado ("Ana ... STATUS:
                    // PAGO") de parecer uma linha própria da comanda (trava anti-forja do web).
                    let hanging = if i > 0 && *align == Align::Left { INDENT_PX } else { 0.0 };
                    let x = match align {
                        Align::Left => content_left + indent_px + hanging,
                        Align::Center => content_left + indent_px + ((avail - w) / 2.0).max(0.0),
                        Align::Right => content_left + (content_width - w).max(0.0),
                    };
                    ts.draw(&mut canvas, &line, x, y + ascent, *strong, *big);
                    y += lh;
                }
            }
            Block::Row { left, right, strong, indent } => {
                let indent_px = *indent as f32 * INDENT_PX;
                let lh = ts.line_height(false);
                let ascent = ts.font(*strong).as_scaled(ts.scale(false)).ascent();
                let right_w = ts.measure(right, *strong, false);
                let left_avail = (content_width - indent_px - right_w - COLUMN_GAP).max(content_width * 0.4);
                let lines = ts.wrap(left, left_avail, *strong, false);
                // A coluna da direita sai na PRIMEIRA linha; o texto da esquerda pode continuar
                // abaixo dela (nome de produto longo).
                ts.draw(&mut canvas, right, content_left + content_width - right_w, y + ascent, *strong, false);
                for line in lines {
                    ts.draw(&mut canvas, &line, content_left + indent_px, y + ascent, *strong, false);
                    y += lh;
                }
            }
            Block::Rule { double } => {
                let y0 = y as usize + 5;
                canvas.fill_rect(SIDE_MARGIN, y0, width - 2 * SIDE_MARGIN, 2);
                if *double {
                    canvas.fill_rect(SIDE_MARGIN, y0 + 5, width - 2 * SIDE_MARGIN, 2);
                    y += 14.0;
                } else {
                    y += 10.0;
                }
            }
            Block::Space => {
                y += (ts.base_px * 0.45).ceil();
            }
            Block::Mono { text, align, strong, tall } => {
                let chars: Vec<char> = text.chars().collect();
                if chars.len() > cols {
                    return Err(format!(
                        "linha do cupom com {} colunas numa bobina de {}",
                        chars.len(),
                        cols
                    ));
                }
                let cell = content_width / cols as f32;
                let scale = PxScale {
                    x: cell * MONO_GLYPH_WIDTH_FACTOR,
                    y: if *tall { MONO_GLYPH_HEIGHT_PX * 2.0 } else { MONO_GLYPH_HEIGHT_PX },
                };
                let first_col = match align {
                    Align::Left => 0,
                    Align::Center => (cols - chars.len()) / 2,
                    Align::Right => cols - chars.len(),
                };
                let baseline = y + ts.font(*strong).as_scaled(scale).ascent();
                for (i, ch) in chars.iter().enumerate() {
                    if ch.is_whitespace() {
                        continue;
                    }
                    let cell_left = content_left + (first_col + i) as f32 * cell;
                    ts.draw_in_cell(&mut canvas, *ch, cell_left, cell, baseline, *strong, scale);
                }
                y += (scale.y * LINE_HEIGHT).ceil();
            }
            Block::Qr { modules, align } => {
                let size = modules.len();
                if !(QR_MIN_SIZE..=QR_MAX_SIZE).contains(&size) || (size - QR_MIN_SIZE) % 4 != 0 {
                    return Err(format!("QR Code com tamanho invalido ({size} modulos)"));
                }
                if modules
                    .iter()
                    .any(|row| row.len() != size || row.bytes().any(|b| b != b'0' && b != b'1'))
                {
                    return Err("QR Code com linha invalida".to_string());
                }
                let Some(dots) = qr_module_dots(size, width - 2 * SIDE_MARGIN) else {
                    return Err(format!("QR Code de {size} modulos nao cabe na bobina de {cols} colunas"));
                };
                let side = size * dots;
                let quiet = qr_quiet_dots(size, dots);
                let x0 = match align {
                    Align::Left => SIDE_MARGIN + quiet,
                    Align::Center => (width - side) / 2,
                    Align::Right => width - SIDE_MARGIN - quiet - side,
                };
                let y0 = y.ceil() as usize + quiet;
                for (r, row) in modules.iter().enumerate() {
                    for (c, b) in row.bytes().enumerate() {
                        if b == b'1' {
                            canvas.fill_rect(x0 + c * dots, y0 + r * dots, dots, dots);
                        }
                    }
                }
                y = (y0 + side + quiet) as f32;
            }
        }
        canvas.ensure_rows(y.ceil() as usize);
    }
    // Respiro no fim, antes do avanço/corte.
    canvas.ensure_rows(y.ceil() as usize + 4);
    Ok(canvas)
}

/// Bytes ESC/POS da comanda em modo gráfico: inicialização, o bitmap em bandas `GS v 0`,
/// avanço de papel e corte — o MESMO fecho do modo texto (`build_escpos`).
pub fn build_escpos_graphic(layout_json: &str, width_cols: i32, font_pt: f64) -> Result<Vec<u8>, String> {
    let layout: Layout = serde_json::from_str(layout_json).map_err(|e| format!("layout da comanda invalido: {e}"))?;
    if layout.blocks.is_empty() {
        return Err("layout da comanda vazio".to_string());
    }
    let canvas = render_layout(&layout, width_cols, font_pt)?;
    let (bytes_per_row, rows) = canvas.packed_rows();

    let mut out: Vec<u8> = Vec::with_capacity(rows.len() * bytes_per_row + 64);
    out.extend_from_slice(&[0x1B, 0x40]); // ESC @ — inicializa
    out.extend_from_slice(&[0x1B, 0x61, 0x00]); // ESC a 0 — alinhado à esquerda
    for band in rows.chunks(RASTER_BAND_ROWS) {
        let h = band.len();
        out.extend_from_slice(&[0x1D, 0x76, 0x30, 0x00]); // GS v 0, modo normal
        out.push((bytes_per_row & 0xFF) as u8);
        out.push(((bytes_per_row >> 8) & 0xFF) as u8);
        out.push((h & 0xFF) as u8);
        out.push(((h >> 8) & 0xFF) as u8);
        for row in band {
            out.extend_from_slice(row);
        }
    }
    out.extend_from_slice(b"\n\n\n\n");
    out.extend_from_slice(&[0x1D, 0x56, 0x42, 0x00]); // GS V 66 0 — corte parcial
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"blocks":[
      {"kind":"text","text":"DISK PIZZAIOLO","align":"center","strong":true},
      {"kind":"rule","double":true},
      {"kind":"text","text":"ENTREGA","align":"center","strong":true,"big":true},
      {"kind":"rule","double":true},
      {"kind":"row","left":"1x PIZZA TRADICIONAL (GRANDE)","right":"R$ 83,00","strong":true},
      {"kind":"text","text":"- QUATRO QUEIJOS","indent":1},
      {"kind":"rule"},
      {"kind":"row","left":"TOTAL","right":"R$ 122,81","strong":true},
      {"kind":"space"}
    ]}"#;

    #[test]
    fn desenha_o_documento_na_largura_das_colunas() {
        let layout: Layout = serde_json::from_str(SAMPLE).unwrap();
        let canvas = render_layout(&layout, 48, 9.0).unwrap();
        assert_eq!(canvas.width, 576);
        assert!(canvas.height() > 100);
        // Há tinta na imagem.
        assert!(canvas.pixels.iter().any(|p| *p >= INK_THRESHOLD));
        let canvas58 = render_layout(&layout, 32, 9.0).unwrap();
        assert_eq!(canvas58.width, 384);
    }

    #[test]
    fn os_bytes_comecam_com_esc_arroba_e_terminam_com_o_corte() {
        let bytes = build_escpos_graphic(SAMPLE, 48, 9.0).unwrap();
        assert_eq!(&bytes[0..2], &[0x1B, 0x40]);
        assert!(bytes.windows(4).any(|w| w == [0x1D, 0x76, 0x30, 0x00]));
        assert_eq!(&bytes[bytes.len() - 4..], &[0x1D, 0x56, 0x42, 0x00]);
    }

    #[test]
    fn layout_invalido_ou_vazio_e_erro_em_voz_alta() {
        assert!(build_escpos_graphic("{", 48, 9.0).is_err());
        assert!(build_escpos_graphic(r#"{"blocks":[]}"#, 48, 9.0).is_err());
    }

    // ------------------------------------------------------------ cupom fiscal: `qr` e `mono`
    // Rodam SEM compilar o Tauri, pelo crate `src-tauri/raster-tests/` (`cargo test` lá dentro).

    /// Matriz quadrada de `size` módulos; `escuro(linha, coluna)` diz qual módulo tem tinta.
    fn matriz(size: usize, escuro: impl Fn(usize, usize) -> bool) -> Vec<String> {
        (0..size)
            .map(|r| (0..size).map(|c| if escuro(r, c) { '1' } else { '0' }).collect())
            .collect()
    }

    fn layout_qr(modules: &[String], align: &str) -> String {
        serde_json::json!({ "blocks": [{ "kind": "qr", "modules": modules, "align": align }] }).to_string()
    }

    fn render(json: &str, cols: i32) -> Result<Canvas, String> {
        let layout: Layout = serde_json::from_str(json).map_err(|e| e.to_string())?;
        render_layout(&layout, cols, 9.0)
    }

    /// Caixa da tinta: (x_min, y_min, x_max, y_max), inclusivos.
    fn caixa_da_tinta(canvas: &Canvas) -> Option<(usize, usize, usize, usize)> {
        let mut caixa: Option<(usize, usize, usize, usize)> = None;
        for y in 0..canvas.height() {
            for x in 0..canvas.width {
                if canvas.pixels[y * canvas.width + x] >= INK_THRESHOLD {
                    caixa = Some(match caixa {
                        None => (x, y, x, y),
                        Some((a, b, c, d)) => (a.min(x), b.min(y), c.max(x), d.max(y)),
                    });
                }
            }
        }
        caixa
    }

    #[test]
    fn qr_sai_em_quadrados_escalados_centralizados_e_com_zona_de_silencio() {
        for cols in [32i32, 48] {
            let size = 21;
            let width = cols as usize * DOTS_PER_COLUMN;
            let canvas = render(&layout_qr(&matriz(size, |_, _| true), "center"), cols).unwrap();
            assert_eq!(canvas.width, width);
            let dots = QR_MAX_MODULE_DOTS;
            let quiet = qr_quiet_dots(size, dots);
            let (x0, y0, x1, y1) = caixa_da_tinta(&canvas).unwrap();
            // Quadrado de 21 módulos de `dots` pontos.
            assert_eq!(x1 - x0 + 1, size * dots);
            assert_eq!(y1 - y0 + 1, size * dots);
            // Centralizado na bobina.
            assert!(x0.abs_diff(width - 1 - x1) <= 1, "{cols}: {x0}..{x1}");
            // Zona de silêncio nos quatro lados (dentro da margem, nas laterais).
            assert_eq!(y0, quiet);
            assert!(canvas.height() - 1 - y1 >= quiet);
            assert!(x0 >= SIDE_MARGIN + quiet);
            assert!(width - 1 - x1 >= SIDE_MARGIN + quiet);
        }
    }

    #[test]
    fn qr_zona_de_silencio_e_o_maior_entre_4_modulos_10_porcento_e_3_mm() {
        for size in (QR_MIN_SIZE..=QR_MAX_SIZE).step_by(4) {
            for dots in QR_MIN_MODULE_DOTS..=QR_MAX_MODULE_DOTS {
                let quiet = qr_quiet_dots(size, dots);
                assert!(quiet >= 4 * dots, "{size}x{dots}: menos de 4 modulos");
                assert!(quiet * 10 >= size * dots, "{size}x{dots}: menos de 10% do lado");
                assert!(quiet >= 24, "{size}x{dots}: menos de 3 mm");
            }
        }
        // No papel: nenhum ponto de tinta na zona de silêncio (QR típico da NFC-e, 53 módulos).
        for cols in [32i32, 48] {
            let size = 53;
            let width = cols as usize * DOTS_PER_COLUMN;
            let canvas = render(&layout_qr(&matriz(size, |_, _| true), "center"), cols).unwrap();
            let dots = qr_module_dots(size, width - 2 * SIDE_MARGIN).unwrap();
            let quiet = qr_quiet_dots(size, dots);
            let (x0, y0, x1, y1) = caixa_da_tinta(&canvas).unwrap();
            assert_eq!(x1 - x0 + 1, size * dots);
            assert_eq!(y0, quiet, "acima");
            assert!(canvas.height() - 1 - y1 >= quiet, "abaixo");
            assert!(x0 >= SIDE_MARGIN + quiet && width - 1 - x1 >= SIDE_MARGIN + quiet, "laterais");
            assert!(quiet * 10 >= size * dots && quiet >= 24);
        }
    }

    #[test]
    fn qr_desenha_cada_modulo_no_lugar_certo() {
        let size = 25;
        let escuro = |r: usize, c: usize| (r * 7 + c * 3) % 5 == 0;
        let canvas = render(&layout_qr(&matriz(size, escuro), "left"), 48).unwrap();
        let dots = QR_MAX_MODULE_DOTS;
        let quiet = qr_quiet_dots(size, dots);
        for r in 0..size {
            for c in 0..size {
                let x = SIDE_MARGIN + quiet + c * dots + dots / 2;
                let y = quiet + r * dots + dots / 2;
                let tinta = canvas.pixels[y * canvas.width + x] >= INK_THRESHOLD;
                assert_eq!(tinta, escuro(r, c), "modulo ({r},{c})");
            }
        }
    }

    #[test]
    fn qr_nunca_estoura_a_bobina_e_o_que_nao_cabe_e_erro() {
        for cols in [32i32, 48] {
            let width = cols as usize * DOTS_PER_COLUMN;
            for size in (QR_MIN_SIZE..=QR_MAX_SIZE).step_by(4) {
                let cabe = size * QR_MIN_MODULE_DOTS + 2 * qr_quiet_dots(size, QR_MIN_MODULE_DOTS) <= width - 2 * SIDE_MARGIN;
                for align in ["left", "center", "right"] {
                    match render(&layout_qr(&matriz(size, |_, _| true), align), cols) {
                        Ok(canvas) => {
                            assert!(cabe, "{cols} colunas, {size} modulos: devia recusar");
                            assert_eq!(canvas.width, width);
                            let (x0, _, x1, _) = caixa_da_tinta(&canvas).unwrap();
                            let dots = (x1 - x0 + 1) / size;
                            assert!((QR_MIN_MODULE_DOTS..=QR_MAX_MODULE_DOTS).contains(&dots));
                            let quiet = qr_quiet_dots(size, dots);
                            assert!(
                                x0 >= SIDE_MARGIN + quiet && x1 + quiet + SIDE_MARGIN < width,
                                "{cols} colunas, {size} modulos, {align}: {x0}..{x1}"
                            );
                        }
                        Err(e) => {
                            assert!(!cabe, "{cols} colunas, {size} modulos: {e}");
                            assert!(e.contains("nao cabe"), "{e}");
                        }
                    }
                }
            }
        }
        // O QR de uma NFC-e (versão 8 a 13: 49 a 69 módulos) cabe nas DUAS bobinas.
        for size in [49, 53, 57, 61, 65, 69] {
            for cols in [32, 48] {
                assert!(render(&layout_qr(&matriz(size, |_, _| true), "center"), cols).is_ok());
            }
        }
    }

    #[test]
    fn qr_torto_e_erro_em_voz_alta() {
        // 20 módulos não é versão de QR.
        assert!(render(&layout_qr(&matriz(20, |_, _| true), "center"), 48).is_err());
        // Linha curta, caractere fora de 0/1, matriz vazia e bloco sem matriz.
        let mut curta = matriz(21, |_, _| true);
        curta[3].pop();
        assert!(render(&layout_qr(&curta, "center"), 48).is_err());
        let mut letra = matriz(21, |_, _| true);
        letra[5] = letra[5].replacen('1', "2", 1);
        assert!(render(&layout_qr(&letra, "center"), 48).is_err());
        assert!(render(&layout_qr(&[], "center"), 48).is_err());
        assert!(build_escpos_graphic(r#"{"blocks":[{"kind":"qr"}]}"#, 48, 9.0).is_err());
    }

    #[test]
    fn bloco_desconhecido_continua_sendo_erro_como_antes() {
        // O app nunca desenha o que não conhece: o layout inteiro é recusado (vira falha do job).
        assert!(build_escpos_graphic(r#"{"blocks":[{"kind":"imagem","src":"x"}]}"#, 48, 9.0).is_err());
        assert!(build_escpos_graphic(r#"{"blocks":[{"kind":"text","text":"ok"},{"kind":"barcode"}]}"#, 48, 9.0).is_err());
        // E os blocos da comanda continuam desenhando como sempre.
        assert!(build_escpos_graphic(SAMPLE, 48, 9.0).is_ok());
        assert!(build_escpos_graphic(SAMPLE, 32, 9.0).is_ok());
    }

    #[test]
    fn mono_e_uma_grade_de_colunas_que_nunca_passa_da_bobina() {
        for cols in [32usize, 48] {
            let width = cols * DOTS_PER_COLUMN;
            let cheia = "W".repeat(cols);
            let json = serde_json::json!({ "blocks": [{ "kind": "mono", "text": cheia, "strong": true }] }).to_string();
            let canvas = render(&json, cols as i32).unwrap();
            assert_eq!(canvas.width, width);
            let (x0, _, x1, _) = caixa_da_tinta(&canvas).unwrap();
            assert!(x0 >= SIDE_MARGIN / 2 && x1 < width - SIDE_MARGIN / 2, "{cols}: {x0}..{x1}");
            // Uma coluna a mais é ERRO, nunca corte nem quebra silenciosa.
            let estoura = serde_json::json!({ "blocks": [{ "kind": "mono", "text": "W".repeat(cols + 1) }] }).to_string();
            let erro = render(&estoura, cols as i32).err().expect("linha maior que a bobina devia ser recusada");
            assert!(erro.contains("linha do cupom"), "{erro}");
        }
        // Acento do português sai desenhado (o raster não translitera).
        let acento = serde_json::json!({ "blocks": [{ "kind": "mono", "text": "ÇÃÔ" }] }).to_string();
        assert!(caixa_da_tinta(&render(&acento, 48).unwrap()).is_some());
    }

    /// A haste vertical mais FINA do desenho: a menor sequência de tinta por linha, no terço do
    /// meio da altura (onde só há haste em I, l, 1, i, |).
    fn haste_minima(canvas: &Canvas) -> usize {
        let (x0, y0, x1, y1) = caixa_da_tinta(canvas).unwrap();
        let altura = y1 - y0 + 1;
        let mut menor = usize::MAX;
        for y in (y0 + altura / 3)..=(y1 - altura / 3) {
            let mut corrida = 0;
            for x in x0..=x1 + 1 {
                let tinta = x <= x1 && canvas.pixels[y * canvas.width + x] >= INK_THRESHOLD;
                if tinta {
                    corrida += 1;
                } else if corrida > 0 {
                    menor = menor.min(corrida);
                    corrida = 0;
                }
            }
        }
        menor
    }

    #[test]
    fn mono_tem_haste_de_pelo_menos_2_pontos_para_ser_legivel() {
        // A térmica queima ponto a ponto: haste de 1 ponto some nas cabeças gastas. O corpo do
        // cupom (`mono`) é engrossado em +1 ponto, com e sem negrito, nas duas bobinas.
        for cols in [32i32, 48] {
            for ch in ["I", "l", "1", "i", "|", "!"] {
                for strong in [false, true] {
                    let json = serde_json::json!({ "blocks": [{ "kind": "mono", "text": ch, "strong": strong }] }).to_string();
                    let haste = haste_minima(&render(&json, cols).unwrap());
                    assert!(haste >= 2, "{cols} colunas, '{ch}', negrito {strong}: haste de {haste} ponto(s)");
                }
            }
        }
    }

    #[test]
    fn mono_alinha_pela_grade_e_tall_dobra_so_a_altura() {
        let linha = |align: &str, tall: bool| {
            serde_json::json!({ "blocks": [{ "kind": "mono", "text": "R$ 10,00", "align": align, "tall": tall }] })
                .to_string()
        };
        let esquerda = caixa_da_tinta(&render(&linha("left", false), 48).unwrap()).unwrap();
        let centro = caixa_da_tinta(&render(&linha("center", false), 48).unwrap()).unwrap();
        let direita = caixa_da_tinta(&render(&linha("right", false), 48).unwrap()).unwrap();
        let cell = ((576 - 2 * SIDE_MARGIN) / 48) + 1;
        assert!(esquerda.0 < SIDE_MARGIN + cell);
        assert!(direita.2 > 576 - SIDE_MARGIN - cell);
        assert!(centro.0 > esquerda.0 && centro.2 < direita.2);
        // O mesmo texto deslocado de colunas inteiras: a mesma largura de tinta.
        assert!((esquerda.2 - esquerda.0).abs_diff(direita.2 - direita.0) <= 1);
        // `tall` dobra a altura da letra e da linha; a largura não muda (as colunas ficam).
        let alta = render(&linha("left", true), 48).unwrap();
        let baixa = render(&linha("left", false), 48).unwrap();
        let (a, b) = (caixa_da_tinta(&alta).unwrap(), caixa_da_tinta(&baixa).unwrap());
        assert!(alta.height() + 8 >= 2 * baixa.height());
        assert!((a.3 - a.1) + 3 >= 2 * (b.3 - b.1));
        assert!(a.0.abs_diff(b.0) <= 1 && a.2.abs_diff(b.2) <= 1);
    }

    #[test]
    fn cupom_inteiro_sai_com_inicializacao_raster_e_corte_proprio() {
        let total = format!("Valor a pagar R${}113,87", " ".repeat(48 - 16 - 6));
        assert_eq!(total.chars().count(), 48);
        let json = serde_json::json!({ "blocks": [
            { "kind": "mono", "text": "PIZZARIA TESTE LTDA", "align": "center", "strong": true, "tall": true },
            { "kind": "rule" },
            { "kind": "mono", "text": total, "strong": true, "tall": true },
            { "kind": "mono", "text": "" },
            { "kind": "qr", "modules": matriz(29, |r, c| (r + c) % 2 == 0) },
        ]})
        .to_string();
        let bytes = build_escpos_graphic(&json, 48, 9.0).unwrap();
        assert_eq!(&bytes[0..2], &[0x1B, 0x40]);
        assert!(bytes.windows(4).any(|w| w == [0x1D, 0x76, 0x30, 0x00]));
        // UMA chamada = UM corte no fim: cada via do cupom sai com o seu.
        assert_eq!(&bytes[bytes.len() - 4..], &[0x1D, 0x56, 0x42, 0x00]);
    }
}
