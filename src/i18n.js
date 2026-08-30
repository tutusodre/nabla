/* Nabla — interface strings.
 *
 * Loaded before app.js. Error messages that originate inside SymPy live in
 * math.py instead, since they are produced where the failure happens.
 */

(() => {
  'use strict';

  const LANG_KEY = 'nabla.lang.v1';

  const STRINGS = {
    en: {
      'boot.waking': 'Waking the engine',
      'boot.runtime': 'Fetching Python runtime',
      'boot.packages': 'Loading SymPy and NumPy',
      'boot.kernel': 'Starting math kernel',
      'boot.ready': 'Ready',
      'boot.restarting': 'Restarting the engine',
      'boot.note': 'First run downloads Python&nbsp;+&nbsp;SymPy. After that it&rsquo;s cached on the device.',
      'boot.failed': 'The math engine failed to load.',
      'boot.fileProtocol': 'Open Nabla over http:// — workers and modules are blocked on file://.',
      'boot.starting': 'The math engine is still starting.',
      'boot.crashed': 'The math engine hit an unexpected problem.',

      'topbar.export': 'Export history as Markdown',
      'topbar.clear': 'Clear history',
      'topbar.theme.toDark': 'Switch to dark',
      'topbar.theme.toLight': 'Switch to light',
      'topbar.lang': 'Ver em português',

      'intro.lede': 'The power of symbolic math, in the palm of your hand.',
      'intro.derivative': 'derivatives to any order',
      'intro.integral': 'indefinite and definite, <code>oo</code> allowed in bounds',
      'intro.limit': 'one&#8209; or two&#8209;sided',
      'intro.solve': 'type an equation and get its solutions',
      'intro.plot': 'comma&#8209;separate up to four functions',
      'intro.foot': 'Constants: <code>pi</code>, <code>e</code>, <code>oo</code>. <br>'
        + '<code>ln</code> is the natural log, <code>log</code> is base&nbsp;10 '
        + '(<code>log(x, 2)</code> for any other base).',

      'op.derivative': 'Derivative',
      'op.integral': 'Integral',
      'op.limit': 'Limit',
      'op.simplify': 'Simplify',
      'op.solve': 'Solve',
      'op.plot': 'Plot',
      'op.table': 'Table',

      'chip.simplify': 'simplify',
      'chip.solve': 'solve',
      'chip.plot': 'plot',
      'chip.table': 'table',

      'field.wrt': 'wrt',
      'field.order': 'order',
      'field.d': 'd',
      'field.from': 'from',
      'field.to': 'to',
      'field.var': 'var',
      'field.side': 'side',
      'field.both': 'both',
      'field.for': 'for',
      'field.complex': 'complex',
      'field.xFrom': 'x from',
      'field.step': 'step',

      'meta.order': 'order %1 · in %2',
      'meta.indefinite': 'indefinite · d%1',
      'meta.definite': '%1 → %2 · d%3',
      'meta.limit': '%1 → %2',
      'meta.fromRight': ' from the right',
      'meta.fromLeft': ' from the left',
      'meta.simplify': 'simplify & evaluate',
      'meta.for': 'for %1',
      'meta.complex': ' · complex',
      'meta.range': 'x ∈ [%1, %2]',
      'meta.table': '%1 → %2 by %3',

      'act.copy': 'copy',
      'act.latex': 'latex',
      'act.reuse': 'reuse',
      'act.delete': 'delete',
      'act.resetView': 'reset view',
      'act.steps': 'steps',
      'export.steps': '**Steps**',

      'card.failed': '%1 — failed',
      'card.genericError': 'Something went wrong.',
      'card.truncated': 'Showing the first 400 rows.',
      'card.hiddenComplex': '%1 complex root(s) hidden — turn on “complex” to include them.',
      'card.plotFailed': 'Couldn’t draw this plot.',

      'toast.copied': 'Result copied',
      'toast.latexCopied': 'LaTeX copied',
      'toast.copyFailed': 'Copy failed',
      'toast.exported': 'Exported %1',
      'toast.nothingToExport': 'Nothing to export yet',
      'toast.deleted': 'Deleted',
      'toast.undo': 'Undo',
      'toast.cleared': 'History cleared',
      'toast.alreadyEmpty': 'History is already empty',
      'toast.stopped': 'Stopped — engine restarting',
      'toast.stoppedShort': 'Stopped.',

      'keypad.native': 'abc — phone keyboard',
      'keypad.switch': 'Math keypad',
      'keypad.hide': 'Hide keypad',
      'keypad.show': 'Show keypad',
      'keypad.backspace': 'Backspace',
      'keypad.label': 'Math keypad',

      'entry.placeholder': 'Expression',
      'entry.compute': 'Compute',
      'entry.computing': 'Computing',
      'entry.stop': 'Stop',

      'export.title': '# Nabla — calculation history',
      'export.exportedAt': '_Exported %1_',
      'export.input': '**Input**',
      'export.settings': '**Settings**',
      'export.plotted': '_Plotted over x ∈ [%1, %2]._',
      'export.filename': 'nabla-history.md',
    },

    pt: {
      'boot.waking': 'Acordando o motor',
      'boot.runtime': 'Baixando o Python',
      'boot.packages': 'Carregando SymPy e NumPy',
      'boot.kernel': 'Iniciando o núcleo matemático',
      'boot.ready': 'Pronto',
      'boot.restarting': 'Reiniciando o motor',
      'boot.note': 'Na primeira vez o app baixa Python&nbsp;+&nbsp;SymPy. Depois disso fica salvo no aparelho.',
      'boot.failed': 'O motor matemático não carregou.',
      'boot.fileProtocol': 'Abra o Nabla por http:// — workers e módulos são bloqueados em file://.',
      'boot.starting': 'O motor matemático ainda está iniciando.',
      'boot.crashed': 'O motor matemático teve um problema inesperado.',

      'topbar.export': 'Exportar histórico em Markdown',
      'topbar.clear': 'Limpar histórico',
      'topbar.theme.toDark': 'Mudar para o tema escuro',
      'topbar.theme.toLight': 'Mudar para o tema claro',
      'topbar.lang': 'View in English',

      'intro.lede': 'Todo o poder da matemática simbólica na palma da mão.',
      'intro.derivative': 'derivadas de qualquer ordem',
      'intro.integral': 'indefinida e definida, <code>oo</code> vale nos limites',
      'intro.limit': 'lateral ou bilateral',
      'intro.solve': 'digite uma equação e receba as soluções',
      'intro.plot': 'até quatro funções separadas por vírgula',
      'intro.foot': 'Constantes: <code>pi</code>, <code>e</code>, <code>oo</code>. <br>'
        + '<code>ln</code> é o logaritmo natural, <code>log</code> é base&nbsp;10 '
        + '(<code>log(x, 2)</code> para outra base). '
        + 'Também aceita <code>sen</code>, <code>cotg</code>, <code>arcsen</code> e <code>arctg</code>.',

      'op.derivative': 'Derivada',
      'op.integral': 'Integral',
      'op.limit': 'Limite',
      'op.simplify': 'Simplificar',
      'op.solve': 'Resolver',
      'op.plot': 'Gráfico',
      'op.table': 'Tabela',

      'chip.simplify': 'simplificar',
      'chip.solve': 'resolver',
      'chip.plot': 'gráfico',
      'chip.table': 'tabela',

      'field.wrt': 'em',
      'field.order': 'ordem',
      'field.d': 'd',
      'field.from': 'de',
      'field.to': 'até',
      'field.var': 'var',
      'field.side': 'lado',
      'field.both': 'ambos',
      'field.for': 'para',
      'field.complex': 'complexo',
      'field.xFrom': 'x de',
      'field.step': 'passo',

      'meta.order': 'ordem %1 · em %2',
      'meta.indefinite': 'indefinida · d%1',
      'meta.definite': '%1 → %2 · d%3',
      'meta.limit': '%1 → %2',
      'meta.fromRight': ' pela direita',
      'meta.fromLeft': ' pela esquerda',
      'meta.simplify': 'simplificar e avaliar',
      'meta.for': 'para %1',
      'meta.complex': ' · complexo',
      'meta.range': 'x ∈ [%1, %2]',
      'meta.table': '%1 → %2 de %3 em %3',

      'act.copy': 'copiar',
      'act.latex': 'latex',
      'act.reuse': 'reusar',
      'act.delete': 'excluir',
      'act.resetView': 'redefinir',
      'act.steps': 'passos',
      'export.steps': '**Passos**',

      'card.failed': '%1 — falhou',
      'card.genericError': 'Algo deu errado.',
      'card.truncated': 'Mostrando as primeiras 400 linhas.',
      'card.hiddenComplex': '%1 raiz(es) complexa(s) ocultas — ative “complexo” para incluí-las.',
      'card.plotFailed': 'Não consegui desenhar este gráfico.',

      'toast.copied': 'Resultado copiado',
      'toast.latexCopied': 'LaTeX copiado',
      'toast.copyFailed': 'Falha ao copiar',
      'toast.exported': 'Exportado %1',
      'toast.nothingToExport': 'Nada para exportar ainda',
      'toast.deleted': 'Excluído',
      'toast.undo': 'Desfazer',
      'toast.cleared': 'Histórico limpo',
      'toast.alreadyEmpty': 'O histórico já está vazio',
      'toast.stopped': 'Parado — reiniciando o motor',
      'toast.stoppedShort': 'Parado.',

      'keypad.native': 'abc — teclado do celular',
      'keypad.switch': 'Teclado matemático',
      'keypad.hide': 'Ocultar teclado',
      'keypad.show': 'Mostrar teclado',
      'keypad.backspace': 'Apagar',
      'keypad.label': 'Teclado matemático',

      'entry.placeholder': 'Expressão',
      'entry.compute': 'Calcular',
      'entry.computing': 'Calculando',
      'entry.stop': 'Parar',

      'export.title': '# Nabla — histórico de cálculos',
      'export.exportedAt': '_Exportado em %1_',
      'export.input': '**Entrada**',
      'export.settings': '**Opções**',
      'export.plotted': '_Traçado em x ∈ [%1, %2]._',
      'export.filename': 'nabla-historico.md',
    },
  };

  function detect() {
    try {
      const stored = localStorage.getItem(LANG_KEY);
      if (stored === 'en' || stored === 'pt') return stored;
    } catch (err) { /* private mode */ }
    const tags = navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || 'en'];
    return tags.some((tag) => String(tag).toLowerCase().startsWith('pt')) ? 'pt' : 'en';
  }

  let current = detect();

  window.NablaI18n = {
    get lang() { return current; },

    set(lang) {
      current = lang === 'pt' ? 'pt' : 'en';
      try { localStorage.setItem(LANG_KEY, current); } catch (err) { /* private mode */ }
      document.documentElement.lang = current === 'pt' ? 'pt-BR' : 'en';
      return current;
    },

    /* t('meta.order', 2, 'x') — %1, %2 … are positional so translations can
     * reorder them, which Portuguese frequently needs. */
    t(key, ...args) {
      const table = STRINGS[current] || STRINGS.en;
      let text = table[key];
      if (text == null) text = STRINGS.en[key];
      if (text == null) return key;
      return args.reduce(
        (out, value, index) => out.split(`%${index + 1}`).join(String(value)),
        text,
      );
    },
  };

  document.documentElement.lang = current === 'pt' ? 'pt-BR' : 'en';
})();
