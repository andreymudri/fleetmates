-- M2 launch flow (03-architecture 4.1): the first prompt still to type into a launched session once its
-- idle input box appears. NULL once typed, and for every row the launch flow did not create.
ALTER TABLE sessions ADD COLUMN launch_task TEXT;
