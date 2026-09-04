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
}

/// Tamanho base da fonte em pontos de impressora a partir do tamanho configurado no painel
/// (7 = pequena, 9 = normal, 12 = grande — os mesmos valores do modo texto).
fn base_px_for(font_pt: f64) -> f32 {
    if font_pt <= 7.5 {
        22.0
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
}
