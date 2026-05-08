% Sequential reassignment: each line should refine x's sign by replacement,
% not by joining with prior types. The whole chain stays well-typed even
% though the FINAL sign is mixed.
x = 2;          % positive
x = sqrt(x);    % nonneg (sqrt accepts because x was positive)
x = -x;         % nonpositive
disp(x);

% After the chain, take the negation again — should be nonneg, allowing
% sqrt without an `abs`. Under the old unify-on-write, x would have been
% widened to "unknown" and this line would have been rejected.
x = -x;         % nonneg
disp(sqrt(x));
