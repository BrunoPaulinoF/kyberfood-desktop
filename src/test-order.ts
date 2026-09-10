/**
 * COMANDA DE TESTE: um pedido SIMULADO montado com o cardápio REAL da loja.
 *
 * O QUE ISTO RESOLVE. O botão "Testar impressão" mandava ao spooler quatro linhas de texto
 * ("TESTE DE IMPRESSAO / Impressora funcionando!"). Ele provava que a impressora respondia e
 * não provava NADA do que a loja precisa saber antes do primeiro pedido: se o papel comporta
 * a largura configurada, se a fonte escolhida cabe, se o nome do produto do cardápio dela sai
 * inteiro, se o endereço quebra na coluna certa, se o destaque (negrito/altura dupla) sai. A
 * primeira comanda de verdade era o primeiro teste de verdade — com um cliente esperando.
 *
 * POR ISSO O TESTE É UM PEDIDO, e ele passa pelo MESMO `printOrder` da comanda automática:
 * mesmo montador, mesma largura, mesma fonte, mesmo modo gráfico. Um caminho de impressão
 * paralelo só para o teste seria um segundo código para o mesmo documento — e dois códigos
 * para o mesmo documento divergem sempre; a pergunta é só quando. O teste passaria enquanto a
 * comanda de verdade sai errada, que é o oposto do que ele existe para fazer.
 *
 * O PEDIDO DE TESTE NUNCA VAI AO SERVIDOR. `TEST_ORDER_ID` é uma sentinela, deliberadamente
 * NÃO um UUID: ele não é carimbado em `orders.receipt_printed_at`, não entra na fila da
 * comanda (`printedOrderIdsRef`) e não vira status nenhum. O que ele exercita é o caminho do
 * PAPEL, não o do pedido.
 *
 * ESTE MÓDULO NÃO IMPORTA NADA, de propósito: é ele que a suíte do monorepo carrega para
 * travar o formato (`desktop-test-print.test.ts`), e o app desktop não tem suíte própria.
 */

/** Id do pedido de teste. NUNCA um UUID — ele não pode ser confundido com pedido real. */
export const TEST_ORDER_ID = 'kyberfood-teste-de-impressao';

/**
 * Número que sai no topo da comanda. Vai em `order_number`, então `orderDisplayNumber` o
 * imprime literalmente — ninguém na cozinha lê "PEDIDO #TESTE" como um pedido a produzir.
 */
export const TEST_ORDER_NUMBER = 'TESTE';

/**
 * A LINHA QUE IMPEDE A COZINHA DE PRODUZIR, e ela é o par obrigatório do realismo.
 *
 * A comanda de teste é realista de propósito — produto do cardápio, endereço, pagamento,
 * troco. Realista o bastante para alguém do balcão pegar o papel e montar o pedido. Ela vai
 * na OBSERVAÇÃO DO PEDIDO, que a comanda imprime em DESTAQUE logo abaixo dos itens: é a
 * linha que quem monta a sacola lê, e não o rodapé.
 */
export const TEST_ORDER_NOTES = 'COMANDA DE TESTE - NAO PRODUZIR. Cliente, endereco e pedido sao ficticios.';

/** Taxa de entrega do pedido simulado (exercita a linha "Entrega" e a soma do total). */
const TEST_DELIVERY_FEE = 8;

/** Quantos produtos do cardápio entram na comanda de teste. */
const TEST_MAX_ITEMS = 3;

/** Quantas opções de complemento entram por item. Duas para a pizza sair como "1/2 ... 1/2 ...". */
const TEST_MAX_COMPLEMENTS = 2;

export interface TestOrderProductOption {
  name?: string | null;
  price?: number | null;
  /** Preço POR TAMANHO (chave = size.id). Em pizza por sabor é AQUI que mora o valor. */
  sizePrices?: Record<string, number> | null;
  deliveryEnabled?: boolean | null;
}

export interface TestOrderProductGroup {
  name?: string | null;
  options?: TestOrderProductOption[] | null;
  deliveryEnabled?: boolean | null;
  /**
   * Regra de preço do grupo quando mais de uma opção é escolhida. Ausente = soma (adicional
   * comum); `highest_option`/`average_options` são o desenho da PIZZA POR SABOR.
   */
  priceCalculation?: 'fixed' | 'highest_option' | 'average_options' | 'sum_options' | null;
  /** Quantas opções o grupo aceita. */
  maxOptions?: number | null;
  /** Teto POR TAMANHO (chave = size.id): "pequena 2 sabores, grande 4". Vence `maxOptions`. */
  sizeMaxOptions?: Record<string, number> | null;
}

export interface TestOrderProductSize {
  id?: string | null;
  name?: string | null;
  price?: number | null;
}

/** O recorte de `products` que a comanda de teste usa. */
export interface TestOrderProduct {
  name?: string | null;
  price?: number | null;
  product_config?: { sizes?: TestOrderProductSize[] | null } | null;
  complements?: TestOrderProductGroup[] | null;
}

export interface TestOrderItem {
  id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  notes: string;
  complements: Array<{ name: string; price: number; groupName: string | null }>;
  size_name: string | null;
}

export interface TestOrder {
  id: string;
  order_number: string;
  created_at: string;
  status: string;
  total: number;
  subtotal: number;
  delivery_fee: number;
  payment_method: string;
  payment_status: string;
  customer_name: string;
  customer_phone: string;
  delivery_address: string;
  delivery_neighborhood: string;
  notes: string;
  items: TestOrderItem[];
  metadata: {
    saipos: { payment_types: Array<{ code: string; amount: number; change_for: number }> };
    order_type: string;
  };
}

/**
 * Cliente FICTÍCIO. Nome, telefone e endereço inventados — mas com a FORMA de um cadastro
 * real, senão o teste não mede o que precisa medir: é a linha do endereço que estoura a
 * coluna do papel estreito, e é o telefone que passa pelo formatador da comanda.
 *
 * O telefone é da faixa 5555 do DDD 11, reservada a ficção justamente para não existir.
 */
const TEST_CUSTOMER = {
  name: 'Mariana Alves de Souza',
  phone: '5511955550142',
  address: 'Rua das Palmeiras, 245 - Apto 32 (portao azul, ao lado da padaria)',
  neighborhood: 'Jardim Sao Bento',
};

/**
 * Cardápio de reserva, usado só quando a loja ainda NÃO tem produto cadastrado (implantação)
 * ou quando a consulta ao cardápio falha.
 *
 * O teste NUNCA pode deixar de existir por causa disso: quem clica no botão quer saber se a
 * impressora responde, e "não consegui ler seu cardápio" no lugar do papel troca a resposta
 * que ele procura por um problema que não é o dele.
 */
const FALLBACK_PRODUCTS: TestOrderProduct[] = [
  { name: 'X-Salada Especial', price: 32.9 },
  { name: 'Porcao de Batata Frita', price: 24.5 },
  { name: 'Refrigerante 2 Litros', price: 12 },
];

function textoLimpo(value: unknown): string {
  return String(value ?? '').trim();
}

function numero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Duas casas, sem a sobra de ponto flutuante que faria o total não fechar com as parcelas. */
function arredonda(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Escolhe o tamanho do produto. O PRIMEIRO com preço próprio, senão o primeiro que existir —
 * em pizza por sabor todo tamanho tem preço ZERO (o valor mora no sabor) e mesmo assim o nome
 * dele precisa sair na comanda, que é onde a cozinha lê "Grande".
 */
function escolheTamanho(product: TestOrderProduct): TestOrderProductSize | null {
  const sizes = (product.product_config?.sizes || []).filter((s) => textoLimpo(s?.name));
  if (sizes.length === 0) return null;
  return sizes.find((s) => numero(s?.price) > 0) || sizes[0];
}

/**
 * Escolhe o grupo de complemento que entra na comanda: o PRIMEIRO que tenha opção utilizável.
 * Grupo ou opção marcados como não vendidos no delivery (`deliveryEnabled: false`) ficam de
 * fora — imprimir no teste o que a loja tirou do ar mostraria uma comanda que não existe.
 */
function escolheComplementos(
  product: TestOrderProduct,
  sizeId: string | null,
): { opcoes: Array<{ name: string; price: number; groupName: string | null }>; regra: string } {
  const grupos = (product.complements || []).filter((g) => g?.deliveryEnabled !== false);
  for (const grupo of grupos) {
    // O TETO DO GRUPO É RESPEITADO — o do TAMANHO vence o geral, como na venda. Sem isso a
    // comanda de teste sairia com dois sabores numa pizza que só aceita um: uma composição
    // que a loja não vende, e que o PDV recusaria se fosse um pedido de verdade.
    const teto = (sizeId && numero(grupo?.sizeMaxOptions?.[sizeId])) || numero(grupo?.maxOptions) || TEST_MAX_COMPLEMENTS;
    const escolhidas = (grupo?.options || [])
      .filter((o) => o?.deliveryEnabled !== false && textoLimpo(o?.name))
      .slice(0, Math.min(TEST_MAX_COMPLEMENTS, teto));
    if (escolhidas.length === 0) continue;
    return {
      opcoes: escolhidas.map((o) => ({
        name: textoLimpo(o?.name),
        // O preço por TAMANHO vence o preço solto: é assim que a venda cobra, e é o número que
        // faz o total do teste bater com o de um pedido real do mesmo item.
        price: arredonda((sizeId && numero(o?.sizePrices?.[sizeId])) || numero(o?.price)),
        groupName: textoLimpo(grupo?.name) || null,
      })),
      // Sem regra declarada, o grupo de SABOR vale pelo MAIOR: é o padrão da pizza (ver
      // `normalizeProductConfig` no app web) e o lado conservador — somar dois sabores daria
      // uma pizza de R$ 164,80 no papel, e um preço que a loja não pratica desacredita a
      // comanda inteira justamente na hora em que ela está sendo conferida.
      regra: textoLimpo(grupo?.priceCalculation) || (ehSabor(grupo) ? 'highest_option' : 'sum_options'),
    };
  }
  return { opcoes: [], regra: 'sum_options' };
}

/** Grupo de SABOR de pizza. Mesma leitura da comanda, que é por NOME do grupo. */
function ehSabor(grupo: TestOrderProductGroup): boolean {
  return textoLimpo(grupo?.name).toLowerCase().includes('sabor');
}

/**
 * Quanto os complementos escolhidos somam ao item — a MESMA regra da venda
 * (`resolveComplementSelection` no app web). Sem ela, o teste imprimiria um total que um
 * pedido real do mesmo item nunca teria.
 */
function somaComplementos(precos: number[], regra: string): number {
  if (precos.length === 0) return 0;
  if (regra === 'fixed') return 0;
  if (regra === 'highest_option') return Math.max(...precos);
  if (regra === 'average_options') return precos.reduce((a, b) => a + b, 0) / precos.length;
  return precos.reduce((a, b) => a + b, 0);
}

/**
 * Produtos que valem uma linha de comanda: os que TÊM PREÇO por algum caminho (preço-base,
 * tamanho ou complemento). Item que sai R$ 0,00 faria o lojista achar que a comanda está
 * quebrada quando ela está certa — o cadastro é que é de outro tipo.
 *
 * A ordem é resolvida AQUI, por nome: o `select` do cardápio não tem `ORDER BY` e o Postgres
 * não define ordem — sem isso a comanda de teste sairia com produtos diferentes a cada
 * clique, e o lojista não teria como comparar dois papéis.
 */
function escolheProdutos(products: TestOrderProduct[]): TestOrderProduct[] {
  const utilizaveis = (products || [])
    .filter((p) => textoLimpo(p?.name))
    .filter((p) => {
      const size = escolheTamanho(p);
      const comps = escolheComplementos(p, textoLimpo(size?.id) || null).opcoes;
      return numero(p?.price) > 0 || numero(size?.price) > 0 || comps.some((c) => c.price > 0);
    })
    .sort((a, b) => textoLimpo(a?.name).localeCompare(textoLimpo(b?.name), 'pt-BR'));
  return utilizaveis.slice(0, TEST_MAX_ITEMS);
}

/**
 * Monta o pedido simulado. `now` entra por parâmetro para o teste do monorepo poder congelar
 * a data — a comanda imprime data e hora, e elas têm que sair no fuso da loja.
 */
export function buildTestOrder(products: TestOrderProduct[], now: Date = new Date()): TestOrder {
  const escolhidos = escolheProdutos(products);
  const base = escolhidos.length > 0 ? escolhidos : FALLBACK_PRODUCTS;

  const items: TestOrderItem[] = base.map((product, index) => {
    const size = escolheTamanho(product);
    const sizeId = textoLimpo(size?.id) || null;
    const { opcoes: complements, regra } = escolheComplementos(product, sizeId);
    const unit = arredonda(numero(size?.price) || numero(product?.price));
    const extra = somaComplementos(complements.map((c) => c.price), regra);
    // O segundo item sai com 2 unidades: é o que exercita o "2x" e a multiplicação do
    // subtotal, que numa comanda de uma unidade só nunca aparece.
    const quantity = index === 1 ? 2 : 1;
    return {
      id: `${TEST_ORDER_ID}-item-${index + 1}`,
      product_name: textoLimpo(product?.name),
      quantity,
      unit_price: unit,
      subtotal: arredonda((unit + extra) * quantity),
      // Observação no ITEM só no primeiro: ela sai em destaque, colada no produto, e é a
      // linha que a cozinha mais lê — o teste tem que provar que ela sai.
      //
      // O TEXTO É NEUTRO DE PROPÓSITO. O primeiro item é o primeiro em ORDEM ALFABÉTICA, e
      // pode ser uma bebida: "sem cebola" numa água com gás faz o lojista rir da comanda em
      // vez de conferi-la. Embalar separado serve para qualquer item de qualquer cardápio.
      notes: index === 0 ? 'Embalar separado, por favor' : '',
      complements,
      size_name: textoLimpo(size?.name) || null,
    };
  });

  const subtotal = arredonda(items.reduce((acc, item) => acc + item.subtotal, 0));
  const total = arredonda(subtotal + TEST_DELIVERY_FEE);
  // Troco para a próxima nota redonda acima do total: exercita a linha "LEVAR DE TROCO",
  // que é a mais nova da comanda e a que ninguém conferiu no papel ainda.
  const changeFor = Math.ceil((total + 1) / 10) * 10;

  return {
    id: TEST_ORDER_ID,
    order_number: TEST_ORDER_NUMBER,
    created_at: now.toISOString(),
    status: 'confirmed',
    total,
    subtotal,
    delivery_fee: TEST_DELIVERY_FEE,
    payment_method: 'cash',
    payment_status: 'pending',
    customer_name: TEST_CUSTOMER.name,
    customer_phone: TEST_CUSTOMER.phone,
    delivery_address: TEST_CUSTOMER.address,
    delivery_neighborhood: TEST_CUSTOMER.neighborhood,
    notes: TEST_ORDER_NOTES,
    items,
    metadata: {
      saipos: { payment_types: [{ code: 'DIN', amount: total, change_for: changeFor }] },
      order_type: 'delivery',
    },
  };
}
