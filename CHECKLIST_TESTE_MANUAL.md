# Checklist de teste manual

Use este roteiro quando quiser validar se o bot esta pronto para uso real. A ideia e testar como cliente, sem precisar entender o codigo.

## Antes de testar

- O servidor esta rodando.
- O WAHA esta conectado ao WhatsApp.
- O numero usado no teste nao e grupo.
- O `.env` tem `OPENAI_API_KEY`, `WAHA_API_KEY`, `WEBHOOK_API_KEY`, `OWNER_PHONE` e `ADMIN_SECRET`.
- Rode `npm run typecheck` e `npm test` quando possivel.

## Fluxo principal

1. Envie `oi`.
   - Esperado: bot da boas-vindas e pergunta seu nome.

2. Responda com um nome, por exemplo `Joao`.
   - Esperado: bot pergunta qual servico deseja.

3. Envie `volume brasileiro`.
   - Esperado: bot pergunta o dia ou pede horario.

4. Envie `amanha as 10h`.
   - Esperado: se o horario estiver livre, bot pede confirmacao.
   - Se nao estiver livre, deve sugerir outros horarios.
   - Na lista de horarios, slots ocupados ou bloqueados devem aparecer como `--:--`, mantendo o espaco visual da grade.

5. Envie `sim`.
   - Esperado: bot confirma com servico, data e hora.
   - Confira no dashboard se o agendamento apareceu.

## Cancelamento

1. Com um agendamento confirmado a mais de 6h, envie `CANCELAR`.
   - Esperado: bot cancela e o horario volta a ficar livre.

2. Com um agendamento a menos de 6h, envie `CANCELAR`.
   - Esperado: bot avisa que precisa de aprovacao do dono.
   - O dono deve receber aviso no `OWNER_PHONE`.

## Remarcacao

1. Com agendamento confirmado, envie `REMARCAR`.
   - Esperado: bot mostra o agendamento atual e pede novo dia/horario.

2. Envie um novo horario livre.
   - Esperado: bot confirma a remarcacao.
   - No dashboard, o antigo deve ficar como remarcado e o novo como confirmado.

## Casos que costumam revelar bugs

- Enviar duas mensagens muito rapido.
- Enviar `sim` sem ter escolhido horario.
- Enviar horario ocupado e conferir se ele aparece como `--:--` na lista enviada para outro cliente.
- Enviar horario fora do expediente.
- Enviar `cancelar` no meio de um agendamento ainda nao confirmado.
- Enviar audio, figurinha ou imagem.
- Reiniciar o servidor e mandar mensagem logo depois.

## Teste visual da lista de horarios

1. Crie um agendamento confirmado em um horario conhecido, por exemplo `10:00`.
   - Pode ser pelo fluxo normal do WhatsApp ou pelo dashboard.

2. Com outro numero, peça horarios para o mesmo servico e dia.
   - Esperado: a lista deve continuar mostrando os horarios em linhas.
   - Esperado: o horario ocupado deve aparecer como `--:--`.
   - Esperado: os horarios livres antes e depois devem continuar aparecendo normalmente.

3. Tente escolher o horario ocupado.
   - Esperado: o bot deve recusar e pedir outro horario.

## Como me relatar um bug

Copie este modelo:

```text
O que eu mandei:

O que o bot respondeu:

O que eu esperava:

Horario aproximado do teste:

Print ou texto do dashboard, se tiver:
```
