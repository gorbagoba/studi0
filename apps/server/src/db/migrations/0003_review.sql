-- lesson review + hypercorrection confidence
ALTER TABLE lessons ADD COLUMN reviewed_at TEXT;
ALTER TABLE attempts ADD COLUMN confidence TEXT;
