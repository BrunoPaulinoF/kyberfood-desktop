//! Impressão no Windows por chamada DIRETA à API do sistema (`winspool.drv`), sem PowerShell.
//!
//! POR QUE ESTE ARQUIVO EXISTE: o caminho anterior GRAVAVA UM `.ps1` em `%TEMP%` e o
//! executava com `-ExecutionPolicy Bypass` numa janela oculta; esse script compilava C# em
//! tempo de execução (`Add-Type`) só para chamar as MESMAS funções de `winspool.drv` que
//! estão declaradas aqui embaixo. Para o antivírus do Windows essa sequência é a assinatura
//! de comportamento de um malware, item por item — soltar script em pasta temporária, rodar
//! escondido com a política de execução burlada e gerar código na memória. Era o que fazia o
//! Defender acusar o app como vírus. Chamando a API direto do Rust nada disso acontece: não
//! há processo filho, não há arquivo temporário e não há código gerado em tempo de execução.
//!
//! O ganho não é só o antivírus: some a partida do PowerShell (centenas de milissegundos por
//! comanda) e some a dependência da política de execução da máquina do lojista.
//!
//! **NÃO reintroduza PowerShell aqui.** A trava é `desktop-no-powershell.test.ts`, que varre
//! o FONTE deste projeto — o app desktop não tem suíte própria, o Rust não compila neste
//! ambiente e o `.exe` só existe depois do merge, no runner Windows.

use std::ffi::{c_void, OsStr};
use std::iter::once;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

type Bool32 = i32;
type Dword = u32;
type Handle = *mut c_void;

/// Impressoras instaladas na máquina + as compartilhadas às quais ela está conectada.
const PRINTER_ENUM_LOCAL: Dword = 0x0000_0002;
const PRINTER_ENUM_CONNECTIONS: Dword = 0x0000_0004;

/// `ShellExecuteExW`: devolve o handle do processo (para esperarmos por ele) e não abre
/// caixa de erro nenhuma na tela da loja.
const SEE_MASK_NOCLOSEPROCESS: Dword = 0x0000_0040;
const SEE_MASK_FLAG_NO_UI: Dword = 0x0000_0400;
const SW_HIDE: i32 = 0;

/// Teto da espera pelo leitor de PDF. O caminho antigo (`Start-Process -Wait`) esperava para
/// SEMPRE: um leitor travado pendurava a thread do comando do Tauri e o app parava de
/// imprimir até ser reaberto.
const PDF_WAIT_TIMEOUT_MS: Dword = 120_000;

#[repr(C)]
struct DocInfo1W {
    p_doc_name: *const u16,
    p_output_file: *const u16,
    p_datatype: *const u16,
}

/// Nível 4 é o recomendado para LISTAR impressoras: só nome, servidor e atributos, sem
/// abrir cada impressora uma a uma (o nível 2 faz isso e é lento em rede).
#[repr(C)]
struct PrinterInfo4W {
    p_printer_name: *const u16,
    p_server_name: *const u16,
    attributes: Dword,
}

#[repr(C)]
struct ShellExecuteInfoW {
    cb_size: Dword,
    f_mask: Dword,
    hwnd: Handle,
    lp_verb: *const u16,
    lp_file: *const u16,
    lp_parameters: *const u16,
    lp_directory: *const u16,
    n_show: i32,
    h_inst_app: Handle,
    lp_id_list: *mut c_void,
    lp_class: *const u16,
    hkey_class: Handle,
    dw_hot_key: Dword,
    h_icon_or_monitor: Handle,
    h_process: Handle,
}

#[link(name = "winspool")]
extern "system" {
    fn OpenPrinterW(printer_name: *const u16, printer: *mut Handle, defaults: *mut c_void) -> Bool32;
    fn ClosePrinter(printer: Handle) -> Bool32;
    fn StartDocPrinterW(printer: Handle, level: Dword, doc_info: *const DocInfo1W) -> Dword;
    fn EndDocPrinter(printer: Handle) -> Bool32;
    fn StartPagePrinter(printer: Handle) -> Bool32;
    fn EndPagePrinter(printer: Handle) -> Bool32;
    fn WritePrinter(printer: Handle, buf: *const c_void, count: Dword, written: *mut Dword) -> Bool32;
    fn EnumPrintersW(
        flags: Dword,
        name: *const u16,
        level: Dword,
        printer_enum: *mut u8,
        buf_size: Dword,
        needed: *mut Dword,
        returned: *mut Dword,
    ) -> Bool32;
    fn GetDefaultPrinterW(buffer: *mut u16, size: *mut Dword) -> Bool32;
}

#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteExW(exec_info: *mut ShellExecuteInfoW) -> Bool32;
}

#[link(name = "kernel32")]
extern "system" {
    fn WaitForSingleObject(handle: Handle, milliseconds: Dword) -> Dword;
    fn CloseHandle(handle: Handle) -> Bool32;
}

/// Texto do Windows: UTF-16 terminado em zero.
fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(once(0)).collect()
}

/// A mensagem do sistema, não só o número: é ela que aparece para o lojista quando o
/// spooler recusa a comanda ("Acesso negado", "O nome da impressora é inválido").
fn last_error(what: &str) -> String {
    format!("{} ({})", what, std::io::Error::last_os_error())
}

/// Fecha a impressora aconteça o que acontecer no meio do caminho — sem isso um erro de
/// escrita deixaria o handle aberto e a impressora presa até o app ser fechado.
struct PrinterHandle(Handle);

impl Drop for PrinterHandle {
    fn drop(&mut self) {
        unsafe { ClosePrinter(self.0) };
    }
}

/// Lê uma string UTF-16 terminada em zero devolvida pelo Windows.
///
/// # Safety
/// `ptr` precisa apontar para uma sequência UTF-16 terminada em zero e válida.
unsafe fn read_wide(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
}

/// Nome da impressora padrão do Windows. `None` quando não há nenhuma configurada — que é
/// um estado normal, não um erro.
fn default_printer() -> Option<String> {
    let mut needed: Dword = 0;
    // Primeira chamada só para descobrir o tamanho: ela FALHA de propósito.
    unsafe { GetDefaultPrinterW(std::ptr::null_mut(), &mut needed) };
    if needed == 0 {
        return None;
    }
    let mut buffer = vec![0u16; needed as usize];
    let ok = unsafe { GetDefaultPrinterW(buffer.as_mut_ptr(), &mut needed) };
    if ok == 0 {
        return None;
    }
    let name = unsafe { read_wide(buffer.as_ptr()) };
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Impressoras disponíveis, com a marca de qual é a padrão do Windows.
///
/// Substitui `Get-CimInstance Win32_Printer` — que além do PowerShell oculto era uma
/// consulta WMI, outro comportamento que o antivírus vigia.
pub fn list_printers() -> Vec<(String, bool)> {
    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let mut needed: Dword = 0;
    let mut returned: Dword = 0;

    // Primeira chamada com buffer vazio: ela FALHA e devolve em `needed` o tamanho real.
    unsafe {
        EnumPrintersW(
            flags,
            std::ptr::null(),
            4,
            std::ptr::null_mut(),
            0,
            &mut needed,
            &mut returned,
        )
    };

    if needed == 0 {
        return Vec::new();
    }

    // O buffer recebe STRUCTS com ponteiros, então ele precisa estar alinhado para
    // ponteiro. `Vec<u8>` não garante isso — `Vec<u64>` garante, e o custo é o mesmo.
    let word = std::mem::size_of::<u64>();
    let words = (needed as usize + word - 1) / word;
    let mut buffer = vec![0u64; words];
    let buffer_bytes = buffer.as_mut_ptr() as *mut u8;

    let ok = unsafe {
        EnumPrintersW(
            flags,
            std::ptr::null(),
            4,
            buffer_bytes,
            needed,
            &mut needed,
            &mut returned,
        )
    };
    if ok == 0 {
        return Vec::new();
    }

    let default = default_printer();
    let entries = buffer_bytes as *const PrinterInfo4W;
    let mut printers = Vec::with_capacity(returned as usize);
    for index in 0..returned as usize {
        // Os nomes apontam para DENTRO de `buffer`, que continua vivo até o fim da função.
        let name = unsafe { read_wide((*entries.add(index)).p_printer_name) };
        if name.is_empty() {
            continue;
        }
        let is_default = default.as_deref() == Some(name.as_str());
        printers.push((name, is_default));
    }
    printers
}

/// Manda os bytes da comanda direto ao spooler no formato RAW (ESC/POS).
///
/// É o mesmo mecanismo que todo software de PDV usa: não depende de leitor de PDF, de
/// driver GDI nem de diálogo de impressão — por isso "sempre imprime".
pub fn send_raw(printer: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("Comanda vazia".to_string());
    }

    let printer_name = wide(printer);
    let mut handle: Handle = std::ptr::null_mut();
    let opened = unsafe {
        OpenPrinterW(
            printer_name.as_ptr(),
            &mut handle,
            std::ptr::null_mut(),
        )
    };
    if opened == 0 || handle.is_null() {
        return Err(last_error(&format!(
            "Não consegui abrir a impressora '{}'",
            printer
        )));
    }
    let handle = PrinterHandle(handle);

    let doc_name = wide("KyberFood Comanda");
    let datatype = wide("RAW");
    let doc_info = DocInfo1W {
        p_doc_name: doc_name.as_ptr(),
        p_output_file: std::ptr::null(),
        p_datatype: datatype.as_ptr(),
    };

    // Devolve o número do job; ZERO é falha.
    let job = unsafe { StartDocPrinterW(handle.0, 1, &doc_info) };
    if job == 0 {
        return Err(last_error("O spooler recusou o documento"));
    }

    let result = write_document(handle.0, bytes);

    // O documento é encerrado SEMPRE, inclusive depois de uma falha de escrita: sem isso o
    // job fica pendurado na fila e a impressora não aceita o próximo.
    unsafe { EndDocPrinter(handle.0) };
    result
}

/// Uma página com todos os bytes: a comanda térmica é um fluxo contínuo, e o corte já vem
/// dentro do próprio ESC/POS.
fn write_document(handle: Handle, bytes: &[u8]) -> Result<(), String> {
    if unsafe { StartPagePrinter(handle) } == 0 {
        return Err(last_error("O spooler recusou a página"));
    }

    let mut offset = 0usize;
    while offset < bytes.len() {
        let chunk = &bytes[offset..];
        // `WritePrinter` conta em 32 bits; a comanda nunca chega perto disso, mas a conta
        // fica correta por construção em vez de por sorte.
        let count = Dword::try_from(chunk.len()).unwrap_or(Dword::MAX);
        let mut written: Dword = 0;
        let ok = unsafe {
            WritePrinter(
                handle,
                chunk.as_ptr() as *const c_void,
                count,
                &mut written,
            )
        };
        if ok == 0 {
            unsafe { EndPagePrinter(handle) };
            return Err(last_error("Falha ao enviar a comanda para a impressora"));
        }
        if written == 0 {
            unsafe { EndPagePrinter(handle) };
            return Err("A impressora não aceitou os dados da comanda".to_string());
        }
        offset += written as usize;
    }

    if unsafe { EndPagePrinter(handle) } == 0 {
        return Err(last_error("Falha ao fechar a página na impressora"));
    }
    Ok(())
}

/// Plano B: manda o PDF da comanda para a impressora pelo verbo `printto` do Windows —
/// o mesmo que o Explorer usa em "Imprimir com". Depende de haver um leitor de PDF
/// associado, por isso é o FALLBACK do caminho RAW.
///
/// Substitui `Start-Process -Verb PrintTo` sem PowerShell no meio.
pub fn print_document(printer: &str, path: &Path) -> Result<(), String> {
    let verb = wide("printto");
    let file = wide(&path.to_string_lossy());
    // O nome da impressora vai entre aspas: sem elas, "HP LaserJet 100" chega ao leitor
    // como três parâmetros e ele imprime na impressora errada (ou em nenhuma).
    let parameters = wide(&format!("\"{}\"", printer.replace('"', "")));

    let mut info = ShellExecuteInfoW {
        cb_size: Dword::try_from(std::mem::size_of::<ShellExecuteInfoW>()).unwrap_or(0),
        f_mask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI,
        hwnd: std::ptr::null_mut(),
        lp_verb: verb.as_ptr(),
        lp_file: file.as_ptr(),
        lp_parameters: parameters.as_ptr(),
        lp_directory: std::ptr::null(),
        n_show: SW_HIDE,
        h_inst_app: std::ptr::null_mut(),
        lp_id_list: std::ptr::null_mut(),
        lp_class: std::ptr::null(),
        hkey_class: std::ptr::null_mut(),
        dw_hot_key: 0,
        h_icon_or_monitor: std::ptr::null_mut(),
        h_process: std::ptr::null_mut(),
    };

    let ok = unsafe { ShellExecuteExW(&mut info) };
    if ok == 0 {
        return Err(last_error(
            "Nenhum leitor de PDF instalado para imprimir a comanda",
        ));
    }

    // Esperar existe para o PDF temporário não ser sobrescrito pela comanda seguinte
    // enquanto o leitor ainda está lendo — o arquivo tem nome fixo.
    if !info.h_process.is_null() {
        // Estourar o prazo NÃO é falha de impressão: o documento já foi entregue ao leitor.
        // Reportar erro aqui faria o app tentar de novo e a comanda sair repetida — por isso
        // o resultado da espera é deliberadamente ignorado.
        unsafe { WaitForSingleObject(info.h_process, PDF_WAIT_TIMEOUT_MS) };
        unsafe { CloseHandle(info.h_process) };
    }
    Ok(())
}
