//! Cifra a credencial guardada no PC com a DPAPI do Windows (`CryptProtectData`).
//!
//! POR QUE ESTE ARQUIVO EXISTE: e-mail e senha do relogin automático ficavam em base64 no
//! `localStorage` e em `%APPDATA%\KyberFood\device-state.json`. Base64 não é criptografia:
//! quem copiasse o arquivo (backup, pasta sincronizada, pendrive, suporte remoto) lia a senha.
//!
//! A DPAPI cifra com uma chave que o próprio Windows guarda para ESTE COMPUTADOR
//! (`CRYPTPROTECT_LOCAL_MACHINE`): o app não tem chave nenhuma para esconder, e o que fica em
//! disco só abre neste computador. Escopo da MÁQUINA, e não do usuário, por decisão do dono
//! (15/11/2026): no escopo do usuário, resetar à força a senha da conta do Windows invalidava
//! o cifrado e a loja teria de digitar a senha de novo — a regra do produto é a conta nunca
//! sair sozinha. O preço: outra conta do Windows NESTE PC também consegue abrir.
//! NÃO troque o escopo sem pensar na migração do que já está cifrado nas lojas.
//! Existe desde o Windows 2000 (`crypt32.dll`), então vale também para a
//! versão Windows 7. Sem dependência nova: declaração direta, como em `win_print.rs`.
//!
//! O QUE ISTO NÃO FAZ: não protege de um programa rodando NESTE computador (ele pode pedir
//! à DPAPI o mesmo que o app pede). O ganho é o arquivo copiado para fora deixar de valer.
//!
//! QUEM DECIDE O QUE FAZER QUANDO FALHA é a interface (`src/credential-vault.ts`): aqui toda
//! falha vira `Err`, nunca um texto "meio certo". Lá, falha de cifra mantém o formato antigo —
//! a regra do produto é a conta nunca sair sozinha. Trava: `desktop-credential-vault.test.ts`.

use std::ffi::c_void;
use std::ptr::{null, null_mut};

type Bool32 = i32;
type Dword = u32;

/// Nunca abre janela pedindo confirmação: o app vive escondido na bandeja.
const CRYPTPROTECT_UI_FORBIDDEN: Dword = 0x0000_0001;
/// Chave do COMPUTADOR, não do usuário: sobrevive a reset de senha e troca de conta do Windows.
/// Só vale ao CIFRAR; ao abrir, o Windows descobre o escopo pelo próprio conteúdo.
const CRYPTPROTECT_LOCAL_MACHINE: Dword = 0x0000_0004;

/// `DATA_BLOB` do Windows: tamanho + ponteiro.
#[repr(C)]
struct DataBlob {
    cb_data: Dword,
    pb_data: *mut u8,
}

#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        data_in: *const DataBlob,
        description: *const u16,
        optional_entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt_struct: *mut c_void,
        flags: Dword,
        data_out: *mut DataBlob,
    ) -> Bool32;
    fn CryptUnprotectData(
        data_in: *const DataBlob,
        description: *mut *mut u16,
        optional_entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt_struct: *mut c_void,
        flags: Dword,
        data_out: *mut DataBlob,
    ) -> Bool32;
}

#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(mem: *mut c_void) -> *mut c_void;
}

/// A saída da DPAPI é alocada pelo Windows e tem que ser devolvida com `LocalFree` — aconteça
/// o que acontecer no meio do caminho.
struct OwnedBlob(DataBlob);

impl Drop for OwnedBlob {
    fn drop(&mut self) {
        if !self.0.pb_data.is_null() {
            unsafe { LocalFree(self.0.pb_data as *mut c_void) };
        }
    }
}

fn dpapi(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    if input.is_empty() {
        return Err("nada para proteger".to_string());
    }
    let len = Dword::try_from(input.len()).map_err(|_| "conteudo grande demais".to_string())?;
    // A DPAPI só LÊ a entrada; o ponteiro é `*mut` porque é assim que o `DATA_BLOB` é declarado.
    let data_in = DataBlob {
        cb_data: len,
        pb_data: input.as_ptr() as *mut u8,
    };
    let mut out = OwnedBlob(DataBlob {
        cb_data: 0,
        pb_data: null_mut(),
    });

    let ok = unsafe {
        if protect {
            CryptProtectData(
                &data_in,
                null(),
                null(),
                null_mut(),
                null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE,
                &mut out.0,
            )
        } else {
            CryptUnprotectData(
                &data_in,
                null_mut(),
                null(),
                null_mut(),
                null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out.0,
            )
        }
    };
    if ok == 0 {
        let what = if protect { "CryptProtectData" } else { "CryptUnprotectData" };
        return Err(format!("{} falhou ({})", what, std::io::Error::last_os_error()));
    }
    if out.0.pb_data.is_null() || out.0.cb_data == 0 {
        return Err("a DPAPI devolveu um resultado vazio".to_string());
    }
    let bytes = unsafe { std::slice::from_raw_parts(out.0.pb_data, out.0.cb_data as usize) };
    Ok(bytes.to_vec())
}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

fn from_hex(text: &str) -> Result<Vec<u8>, String> {
    let raw = text.as_bytes();
    if raw.len() % 2 != 0 {
        return Err("conteudo cifrado com tamanho invalido".to_string());
    }
    let mut out = Vec::with_capacity(raw.len() / 2);
    for pair in raw.chunks(2) {
        let hi = (pair[0] as char)
            .to_digit(16)
            .ok_or_else(|| "conteudo cifrado invalido".to_string())?;
        let lo = (pair[1] as char)
            .to_digit(16)
            .ok_or_else(|| "conteudo cifrado invalido".to_string())?;
        out.push((hi * 16 + lo) as u8);
    }
    Ok(out)
}

/// Cifra o texto para ESTE computador (qualquer conta do Windows nele abre). Devolve em hexadecimal, que cabe
/// sem escape no `localStorage` e no JSON da reserva.
pub fn protect(plain: &str) -> Result<String, String> {
    dpapi(plain.as_bytes(), true).map(|bytes| to_hex(&bytes))
}

/// Abre o que `protect` cifrou. Outro computador ou conteúdo adulterado: `Err`.
pub fn unprotect(blob: &str) -> Result<String, String> {
    let bytes = dpapi(&from_hex(blob)?, false)?;
    String::from_utf8(bytes).map_err(|_| "conteudo decifrado nao e texto".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Roda a DPAPI DE VERDADE: ida e volta com acento, separador de controle e texto longo.
    #[test]
    fn ida_e_volta() {
        let longo = "x".repeat(5000);
        for plain in ["a", "loja@exemplo.com.br\u{1f}Senha#Fórte-ção 123", longo.as_str()] {
            let blob = protect(plain).expect("cifrar");
            assert_ne!(blob, plain);
            assert!(blob.bytes().all(|b| b.is_ascii_hexdigit()));
            assert_eq!(unprotect(&blob).expect("abrir"), plain);
        }
    }

    /// Entrada vazia, lixo e conteúdo adulterado viram `Err`; nada derruba o processo.
    #[test]
    fn falha_vira_err() {
        assert!(protect("").is_err());
        assert!(unprotect("").is_err());
        assert!(unprotect("zz").is_err());
        assert!(unprotect("abc").is_err());
        assert!(unprotect("00112233445566778899").is_err());
        let mut blob = protect("segredo").expect("cifrar");
        let meio = blob.len() / 2;
        let troca = if &blob[meio..meio + 1] == "0" { "1" } else { "0" };
        blob.replace_range(meio..meio + 1, troca);
        assert!(unprotect(&blob).is_err());
    }
}
