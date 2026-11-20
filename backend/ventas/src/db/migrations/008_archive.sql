-- "Empezar de cero": recomendaciones viejas sin revisar quedan archivadas (ni
-- aprobadas ni rechazadas). El agente no las ve, así no aprende un rechazo que no hubo.
ALTER TABLE ad_decisions DROP CONSTRAINT ad_decisions_status_check;
ALTER TABLE ad_decisions ADD CONSTRAINT ad_decisions_status_check CHECK (status IN ('pending','executed','rejected','failed','archived'));
