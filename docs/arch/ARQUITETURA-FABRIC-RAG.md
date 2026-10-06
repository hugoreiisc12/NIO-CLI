# Arquitetura — Fabric / Power BI / RAG de DAX

> Documento de **desenho** (o de operação é `docs/security/runbook-fabric-prod.md`).
> Todo trecho abaixo vem dos cabeçalhos do código; reverifique antes de agir.
> Subsistema com ~4.800 linhas sem teste, antes ausente de `docs/arch/` (backlog § 8.2).

## 1. Problema

O agente escreve DAX de memória e erra: tabela inexistente, `EVALUATE` sem tabela, DMV
que a API não aceita. Cada erro custa uma das 120 req/min do Fabric e não ensina nada.
O subsistema existe para **responder pergunta de negócio com DAX correto, barato e
auditável**, aprendendo com o que deu certo e com o que falhou.

## 2. Mapa de camadas

```
tools/        fabric-{query,ask,schema-sync,measure,datasets,workspaces,shared}.ts · pbi-local.ts
                 └─ superfície MCP (`nio_fabric_*`); só valida entrada e chama app/
app/          dax-rag.ts (orquestrador) · dax-guard.ts · dax-generator.ts · rag-templates.ts
              measure-lookup.ts · scan-to-schema.ts · schema-chunker
              learning.ts · lesson-detector.ts · lesson-outcome.ts
core/         fabric.ts (FabricGateway) · rag.ts (EmbeddingProvider, DocIndex, DaxMemory)
              learning.ts (LessonStore)            ← interfaces puras, zero IO
adapters/     fabric/ (client, token, device-code, scanner, refresh-store, query-metrics)
              powerbi/local-endpoint.ts · embed/local-embedder.ts (ONNX/CPU, 768 dims)
              pg/ (doc-index, dax-memory, lesson repositories — pgvector)
```

Dependências apontam para dentro: `tools → app → core ← adapters`. `adapters/` não
importa `app/` (gate: `src/architecture.test.ts`).

## 3. Contrato de erro

Todo port de IO **nunca lança**: devolve `{status: 'ok'|'unavailable'|'unconfigured'|'failed', …}`
(`RagResult<T>`, `FabricResult`). Aprender é acessório; responder é a função — falha do
banco ou do embedder jamais derruba o turno.

## 4. Fluxo de pergunta → DAX (`dax-rag.ts`)

Três níveis, do mais barato ao mais caro:

| Nível | Gatilho | Ação |
|---|---|---|
| 0 · **Replay** | `question_hash` igual (pergunta normalizada + mesmo dataset) | executa o DAX guardado, literal |
| 1 · **Adapta** | vizinho por cosseno ≥ limiar | o template é **base**; o modelo ajusta parâmetros; pula a busca na doc |
| 2 · **Gera** | abaixo do limiar | contexto da documentação (`DocIndex`) + geração completa (Qwen) |

**Invariante:** template achado por *similaridade* nunca executa sem adaptação. Medido:
perguntas erradas pontuam 0,955–0,965, acima de paráfrases legítimas (0,928), e o Fabric
valida sintaxe, não intenção — o DAX errado roda e devolve número errado em silêncio.
Só o hit por hash replica.

`questionHash` inclui workspace e dataset: o mesmo texto em outro modelo semântico é outra
pergunta (vive em `core/rag.ts`).

## 5. `dax-guard` — gate local

Confere os nomes de tabela do DAX contra o inventário real **antes** de gastar request.
Falha local, instantânea, devolvendo os nomes certos. Puro; o chamador traz o inventário.

## 6. Ingestão de schema

`fabric-schema-sync` → scanner admin (`adapters/fabric/scanner.ts`) ou `INFO.VIEW.*` →
`scan-to-schema.ts` normaliza para a mesma forma → `schema-chunker` grava chunks no
`DocIndex`. Rota do scanner traz a **fórmula** da medida (o dado que faltava). Medida é
lida de volta por `measure-lookup.ts`.

## 7. Aprendizado contínuo (`agent_lesson`)

1. **Detecção determinística** (`lesson-detector`): tool falhou → a próxima tentativa da
   MESMA tool deu certo. Não pergunta ao modelo (medido: ele ignora instrução).
2. `learning.ts` embeda e guarda; na volta, recupera lições parecidas e injeta como **pista**.
3. **Desfecho** (`lesson-outcome`): conta `usos`/`acertos`; lição cuja tool nem foi chamada
   não conta a favor nem contra. Sem isso, a poda não tem dado e o acervo cresce com lição
   ruim — pior que nenhuma.

## 8. Dados

`dax_doc_chunk`, `dax_query_template`, `agent_lesson` (migrations 0010–0011; pgvector,
índices de embedding). Tokens do Fabric: `adapters/fabric/token.ts` + `refresh-store.ts`
(arquivo endurecido por `hardenSecretFile`, valor nunca logado).

## 9. Riscos conhecidos

- `token.ts` tem 344 linhas (acima do limite do harness) — candidato a split por fluxo
  (device-code / refresh / cache).
- O limiar de cosseno é empírico; recalibrar se o modelo de embedding mudar.
- Sem teste de ponta a ponta contra um Fabric real; a cobertura é por injeção.

## 10. Decisões relacionadas

ADR 0016 (camadas), ADR 0015 (exec fora do task system), runbook de prod do Fabric.
