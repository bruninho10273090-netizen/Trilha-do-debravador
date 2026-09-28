-- Planos à venda. O anual sai por R$ 10,00 por mês (cerca de 26% de desconto sobre o mensal).
-- Preço em centavos; sem limite de membros. Para mudar depois: PATCH /api/admin/plans/:planId.
INSERT INTO "plans" ("code", "name", "interval", "price_cents", "currency", "max_members") VALUES
  ('mensal', 'Mensal', 'mensal', 1349, 'BRL', NULL),
  ('anual', 'Anual', 'anual', 11999, 'BRL', NULL)
ON CONFLICT ("code") DO NOTHING;
