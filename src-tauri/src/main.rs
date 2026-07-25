// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use printpdf::*;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufWriter;

#[derive(Debug, Serialize, Deserialize)]
pub struct PrinterInfo {
    name: String,
    is_default: bool,
}

/// Cria um `Command` de powershell já configurado para NÃO abrir janela de
/// console no Windows. Mesmo com o app em `windows_subsystem = "windows"`, cada
/// processo filho `powershell` abre um console próprio que "pisca" na tela —
/// era o que aparecia a cada novo pedido ao imprimir a comanda. A flag
/// CREATE_NO_WINDOW (0x08000000) faz o processo rodar totalmente oculto.
fn powershell_command() -> std::process::Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = std::process::Command::new("powershell");
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("powershell")
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PrintOptions {
    printer_name: Option<String>,
    width: Option<i32>,
}

/// Get list of available printers
#[tauri::command]
fn get_printers() -> Vec<PrinterInfo> {
    // Win32_Printer expõe a coluna `Default` (a impressora padrão do Windows).
    // O antigo `Get-Printer | Select isDefault` NÃO tem essa propriedade, então
    // `is_default` vinha sempre falso e o app nunca pré-selecionava a padrão.
    let output = powershell_command()
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance -ClassName Win32_Printer | Select-Object Name, Default | ConvertTo-Json -Compress",
        ])
        .output();

    match output {
        Ok(out) => {
            let json_str = String::from_utf8_lossy(&out.stdout);
            let trimmed = json_str.trim();

            // Handle both single object or array from ConvertTo-Json
            if trimmed.starts_with('{') {
                if let Ok(p) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    return vec![PrinterInfo {
                        name: p["Name"].as_str().unwrap_or("Unknown").to_string(),
                        is_default: p["Default"].as_bool().unwrap_or(false),
                    }];
                }
            } else if trimmed.starts_with('[') {
                if let Ok(printers) = serde_json::from_str::<Vec<serde_json::Value>>(trimmed) {
                    return printers
                        .into_iter()
                        .map(|p| PrinterInfo {
                            name: p["Name"].as_str().unwrap_or("Unknown").to_string(),
                            is_default: p["Default"].as_bool().unwrap_or(false),
                        })
                        .collect();
                }
            }
            vec![]
        }
        Err(_) => vec![],
    }
}

/// Transliteração para ASCII: impressoras térmicas usam por padrão uma página de
/// código (CP437/CP850/…) que varia por modelo, então acentos "crus" saem como
/// lixo em alguns aparelhos. Convertendo para ASCII a comanda é SEMPRE legível em
/// qualquer impressora — prioridade nº 1 do app (imprimir de forma confiável).
/// Trocamos fidelidade de acento por robustez: comanda de cozinha não precisa de acento.
fn to_ascii_bytes(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    for ch in text.chars() {
        if ch.is_ascii() {
            // Só ASCII IMPRIMÍVEL (0x20–0x7E). Bytes de controle vindos de um campo do
            // pedido (nome, endereço, observação) seriam COMANDOS para a impressora:
            // "ESC = 0" a deseleciona (o spooler aceita os jobs e nada mais imprime),
            // "GS V" corta a comanda no meio e "ESC p" abre a gaveta de dinheiro.
            // A quebra de linha legítima é emitida por build_escpos, nunca pelo conteúdo.
            let byte = ch as u8;
            out.push(if (0x20..=0x7E).contains(&byte) { byte } else { b' ' });
            continue;
        }
        let mapped: &[u8] = match ch {
            'á' | 'à' | 'â' | 'ã' | 'ä' | 'å' => b"a",
            'é' | 'è' | 'ê' | 'ë' => b"e",
            'í' | 'ì' | 'î' | 'ï' => b"i",
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => b"o",
            'ú' | 'ù' | 'û' | 'ü' => b"u",
            'ç' => b"c",
            'ñ' => b"n",
            'ý' | 'ÿ' => b"y",
            'Á' | 'À' | 'Â' | 'Ã' | 'Ä' | 'Å' => b"A",
            'É' | 'È' | 'Ê' | 'Ë' => b"E",
            'Í' | 'Ì' | 'Î' | 'Ï' => b"I",
            'Ó' | 'Ò' | 'Ô' | 'Õ' | 'Ö' => b"O",
            'Ú' | 'Ù' | 'Û' | 'Ü' => b"U",
            'Ç' => b"C",
            'Ñ' => b"N",
            'ª' => b"a",
            'º' | '°' => b"o",
            '–' | '—' => b"-",
            '“' | '”' | '„' => b"\"",
            '‘' | '’' | '‚' => b"'",
            '…' => b"...",
            '•' => b"*",
            '\u{00A0}' => b" ", // espaço inquebrável
            _ => b"?",
        };
        out.extend_from_slice(mapped);
    }
    out
}

/// Monta o buffer de bytes ESC/POS da comanda a partir do texto já formatado
/// (linhas montadas pelo front, com largura de coluna correta). Isto é o que
/// impressoras térmicas entendem nativamente — sem depender de PDF nem driver GDI.
fn build_escpos(content: &str, font_pt: f64) -> Vec<u8> {
    let mut bytes: Vec<u8> = Vec::new();

    // ESC @ — inicializa a impressora (limpa buffer, volta ao estado padrão).
    bytes.extend_from_slice(&[0x1B, 0x40]);

    // Tamanho da fonte configurado no painel (pequena/normal/grande). Escolhemos
    // variações que PRESERVAM a contagem de colunas (para o alinhamento montado
    // pelo front continuar válido): Fonte B (menor) / Fonte A / altura dupla.
    if font_pt <= 7.5 {
        bytes.extend_from_slice(&[0x1B, 0x4D, 0x01]); // ESC M 1 -> Fonte B (compacta)
    } else if font_pt >= 11.0 {
        bytes.extend_from_slice(&[0x1D, 0x21, 0x01]); // GS ! 0x01 -> altura dupla
    } else {
        bytes.extend_from_slice(&[0x1B, 0x4D, 0x00]); // ESC M 0 -> Fonte A (padrão)
    }

    // Corpo: cada linha do texto vira bytes ASCII + avanço de linha (LF).
    for line in content.lines() {
        bytes.extend_from_slice(&to_ascii_bytes(line));
        bytes.push(b'\n');
    }

    // Avança o papel para o conteúdo sair além da lâmina antes do corte.
    bytes.extend_from_slice(b"\n\n\n\n");
    // GS V 66 0 — corte parcial com avanço. Impressoras sem guilhotina ignoram.
    bytes.extend_from_slice(&[0x1D, 0x56, 0x42, 0x00]);

    bytes
}

/// Envia bytes RAW direto ao spooler do Windows (datatype "RAW"), via um helper
/// P/Invoke (winspool) carregado por Add-Type. É o mesmo mecanismo que todo
/// software de PDV usa: NÃO depende de leitor de PDF, driver GDI nem diálogo —
/// por isso "sempre imprime". Retorna Err com a causa quando o spooler recusa.
#[cfg(target_os = "windows")]
fn send_raw_to_printer(printer: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;

    // Grava os bytes da comanda num arquivo temporário que o PowerShell lê.
    let bin_path = std::env::temp_dir().join("kyberfood_receipt.bin");
    let mut f = File::create(&bin_path).map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    drop(f);

    // Escapa aspas simples ('' = ') para embutir com segurança em strings PS.
    let printer_escaped = printer.replace('\'', "''");
    let bin_escaped = bin_path.to_string_lossy().replace('\'', "''");

    // Helper RawPrinterHelper (padrão consagrado da Microsoft) que abre a
    // impressora, inicia um documento RAW e escreve os bytes direto no spooler.
    let script = format!(
        "$ErrorActionPreference = 'Stop'\n\
         $printerName = '{printer}'\n\
         $filePath = '{file}'\n\
         Add-Type -TypeDefinition @'\n\
using System;\n\
using System.IO;\n\
using System.Runtime.InteropServices;\n\
public class KyberRawPrinter {{\n\
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]\n\
  public class DOCINFOW {{\n\
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;\n\
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;\n\
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;\n\
  }}\n\
  [DllImport(\"winspool.Drv\", EntryPoint = \"OpenPrinterW\", SetLastError = true, CharSet = CharSet.Unicode)]\n\
  public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPWStr)] string src, out IntPtr hPrinter, IntPtr pd);\n\
  [DllImport(\"winspool.Drv\", EntryPoint = \"ClosePrinter\", SetLastError = true)]\n\
  public static extern bool ClosePrinter(IntPtr hPrinter);\n\
  [DllImport(\"winspool.Drv\", EntryPoint = \"StartDocPrinterW\", SetLastError = true, CharSet = CharSet.Unicode)]\n\
  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOW di);\n\
  [DllImport(\"winspool.Drv\", EntryPoint = \"EndDocPrinter\", SetLastError = true)]\n\
  public static extern bool EndDocPrinter(IntPtr hPrinter);\n\
  [DllImport(\"winspool.Drv\", EntryPoint = \"StartPagePrinter\", SetLastError = true)]\n\
  public static extern bool StartPagePrinter(IntPtr hPrinter);\n\
  [DllImport(\"winspool.Drv\", EntryPoint = \"EndPagePrinter\", SetLastError = true)]\n\
  public static extern bool EndPagePrinter(IntPtr hPrinter);\n\
  [DllImport(\"winspool.Drv\", EntryPoint = \"WritePrinter\", SetLastError = true)]\n\
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);\n\
  public static void Send(string printer, byte[] bytes) {{\n\
    IntPtr hPrinter;\n\
    if (!OpenPrinter(printer, out hPrinter, IntPtr.Zero))\n\
      throw new Exception(\"OpenPrinter falhou (\" + Marshal.GetLastWin32Error() + \") para a impressora '\" + printer + \"'\");\n\
    try {{\n\
      DOCINFOW di = new DOCINFOW();\n\
      di.pDocName = \"KyberFood Comanda\";\n\
      di.pDataType = \"RAW\";\n\
      if (!StartDocPrinter(hPrinter, 1, di))\n\
        throw new Exception(\"StartDocPrinter falhou (\" + Marshal.GetLastWin32Error() + \")\");\n\
      try {{\n\
        if (!StartPagePrinter(hPrinter))\n\
          throw new Exception(\"StartPagePrinter falhou (\" + Marshal.GetLastWin32Error() + \")\");\n\
        IntPtr pBytes = Marshal.AllocHGlobal(bytes.Length);\n\
        try {{\n\
          Marshal.Copy(bytes, 0, pBytes, bytes.Length);\n\
          Int32 written;\n\
          if (!WritePrinter(hPrinter, pBytes, bytes.Length, out written))\n\
            throw new Exception(\"WritePrinter falhou (\" + Marshal.GetLastWin32Error() + \")\");\n\
        }} finally {{ Marshal.FreeHGlobal(pBytes); }}\n\
        EndPagePrinter(hPrinter);\n\
      }} finally {{ EndDocPrinter(hPrinter); }}\n\
    }} finally {{ ClosePrinter(hPrinter); }}\n\
  }}\n\
}}\n\
'@\n\
         $bytes = [System.IO.File]::ReadAllBytes($filePath)\n\
         [KyberRawPrinter]::Send($printerName, $bytes)\n",
        printer = printer_escaped,
        file = bin_escaped,
    );

    // Grava o script num .ps1 e roda com bypass da política de execução, sem
    // perfil e sem interação (evita travar em qualquer prompt).
    let ps_path = std::env::temp_dir().join("kyberfood_print.ps1");
    std::fs::write(&ps_path, &script).map_err(|e| e.to_string())?;

    let output = powershell_command()
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &ps_path.to_string_lossy(),
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            stdout.trim().to_string()
        };
        return Err(if detail.is_empty() {
            "Spooler recusou a impressão RAW".to_string()
        } else {
            detail
        });
    }

    Ok(())
}

/// Fallback: gera um PDF e imprime via `Start-Process -Verb PrintTo`. Depende de
/// um leitor de PDF com o verbo PrintTo (nem sempre presente) — por isso é o
/// PLANO B, usado só quando a impressão RAW falha (ex.: impressora não-térmica).
#[cfg(target_os = "windows")]
fn print_via_pdf(printer: &str, content: &str, width: i32, font_pt: f64) -> Result<(), String> {
    let temp_path = render_receipt_pdf(content, width, font_pt)?;

    let printer_escaped = printer.replace('\'', "''");
    let path_str = temp_path.to_string_lossy();

    let output = powershell_command()
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "Start-Process -FilePath '{}' -Verb PrintTo '{}' -Wait",
                path_str, printer_escaped
            ),
        ])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// Gera o PDF da comanda (usado pelo fallback do Windows e pela impressão via lp
/// no macOS/Linux durante o desenvolvimento). Retorna o caminho do arquivo.
fn render_receipt_pdf(content: &str, width: i32, font_pt: f64) -> Result<std::path::PathBuf, String> {
    let paper_width_mm: f64 = if width > 40 { 80.0 } else { 58.0 };
    let font_pt: f64 = font_pt.clamp(6.0, 16.0);
    let line_height: f64 = font_pt * 0.5;

    let lines: Vec<&str> = content.lines().collect();
    let page_height_mm: f64 = (lines.len() as f64) * line_height + 20.0;

    let (doc, page1, layer1) =
        PdfDocument::new("Receipt", Mm(paper_width_mm), Mm(page_height_mm), "Layer 1");
    let current_layer = doc.get_page(page1).get_layer(layer1);
    let font = doc
        .add_builtin_font(BuiltinFont::Courier)
        .map_err(|e| e.to_string())?;

    let mut y_pos: f64 = page_height_mm - 8.0;
    for line in lines {
        current_layer.use_text(line, font_pt, Mm(2.0), Mm(y_pos), &font);
        y_pos -= line_height;
        if y_pos < 3.0 {
            break;
        }
    }

    let temp_path = std::env::temp_dir().join("kyberfood_receipt.pdf");
    doc.save(&mut BufWriter::new(
        File::create(&temp_path).map_err(|e| e.to_string())?,
    ))
    .map_err(|e| e.to_string())?;

    Ok(temp_path)
}

/// Print receipt to specified printer.
///
/// Estratégia (Windows): impressão RAW/ESC-POS direto no spooler primeiro — é o
/// caminho confiável, rápido e sem dependências (não precisa de leitor de PDF).
/// Só se ele falhar caímos para o PDF + PrintTo. No macOS/Linux (dev) usamos lp.
#[tauri::command]
fn print_receipt(
    printer_name: Option<String>,
    content: String,
    width: Option<i32>,
    font_size: Option<f64>,
) -> Result<(), String> {
    // Sem impressora configurada não há para onde imprimir — a antiga "Default"
    // era fictícia e falhava silenciosamente. Erro claro para o front exibir.
    let printer = match printer_name {
        Some(p) if !p.trim().is_empty() => p,
        _ => return Err("Nenhuma impressora configurada".to_string()),
    };

    // Width: 32 chars for 58mm, 48 chars for 80mm
    let receipt_width_chars = width.unwrap_or(32);
    let font_pt: f64 = font_size.unwrap_or(9.0);

    #[cfg(target_os = "windows")]
    {
        // 1) Caminho confiável: RAW/ESC-POS direto no spooler.
        let raw_bytes = build_escpos(&content, font_pt);
        match send_raw_to_printer(&printer, &raw_bytes) {
            Ok(()) => return Ok(()),
            Err(raw_err) => {
                // 2) Fallback: PDF + PrintTo (impressoras não-térmicas / sem ESC/POS).
                match print_via_pdf(&printer, &content, receipt_width_chars, font_pt) {
                    Ok(()) => return Ok(()),
                    Err(pdf_err) => {
                        return Err(format!(
                            "Falha ao imprimir. RAW: {} | PDF: {}",
                            raw_err, pdf_err
                        ));
                    }
                }
            }
        }
    }

    // On macOS/Linux, use lp command (usado no desenvolvimento).
    #[cfg(not(target_os = "windows"))]
    {
        let temp_path = render_receipt_pdf(&content, receipt_width_chars, font_pt)?;
        // "-d" e o nome da impressora precisam ser argv SEPARADOS —
        // "-d nome" em um único argumento não é reconhecido pelo lp.
        let output = std::process::Command::new("lp")
            .args(["-d", printer.as_str(), temp_path.to_str().unwrap()])
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(())
    }
}

/// Test printer connection — usa o MESMO caminho da impressão real (RAW primeiro),
/// para o teste refletir de fato o que acontece ao imprimir uma comanda.
#[tauri::command]
fn test_printer(printer_name: Option<String>) -> Result<(), String> {
    let test_content = "\
================================
       TESTE DE IMPRESSAO
================================
KyberFood Desktop
Impressora funcionando!
================================
"
    .to_string();

    print_receipt(printer_name, test_content, Some(32), Some(9.0))
}

use tauri::{CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTrayMenuItem};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

fn main() {
    let quit = CustomMenuItem::new("quit".to_string(), "Sair");
    let hide = CustomMenuItem::new("hide".to_string(), "Abrir/Esconder");
    let tray_menu = SystemTrayMenu::new()
        .add_item(hide)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);

    let system_tray = SystemTray::new().with_menu(tray_menu);

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .system_tray(system_tray)
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::LeftClick {
                position: _,
                size: _,
                ..
            } => {
                let window = app.get_window("main").unwrap();
                if window.is_visible().unwrap() {
                    window.hide().unwrap();
                } else {
                    window.show().unwrap();
                    window.set_focus().unwrap();
                }
            }
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "quit" => {
                    std::process::exit(0);
                }
                "hide" => {
                    let window = app.get_window("main").unwrap();
                    if window.is_visible().unwrap() {
                        window.hide().unwrap();
                    } else {
                        window.show().unwrap();
                        window.set_focus().unwrap();
                    }
                }
                _ => {}
            },
            _ => {}
        })
        .on_window_event(|event| match event.event() {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                event.window().hide().unwrap();
                api.prevent_close();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_printers,
            print_receipt,
            test_printer
        ])
        .setup(|app| {
            // Garante que o app sempre inicie junto com o Windows (na bandeja).
            // O usuário pode desativar manualmente pelo Gerenciador de Tarefas,
            // mas por padrão deixamos habilitado para nunca perder um pedido.
            let autostart = app.autolaunch();
            let _ = autostart.enable();

            // Check if we should start minimized
            let args: Vec<String> = std::env::args().collect();
            if args.contains(&"--minimized".to_string()) {
                let window = app.get_window("main").unwrap();
                window.hide().unwrap();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
