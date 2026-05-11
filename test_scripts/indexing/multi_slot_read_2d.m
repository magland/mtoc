% Multi-slot read for a 2-D tensor: a colon paired with a scalar,
% range, or another colon. Result-shape rules per slot:
%   - Colon  → keep base.dims[k]
%   - Range  → range count
%   - Scalar → 1 (collapses)
M = [1 2 3; 4 5 6; 7 8 9];
disp(M(:, 2));        % column 2 → 3x1 col vector
disp(M(2, :));        % row 2    → 1x3 row vector
disp(M(:, :));        % full     → same 3x3 matrix
disp(M(1:2, 2:3));    % top-right 2x2 sub-matrix
disp(M(:, 2:3));      % col 2..3 → 3x2 matrix
disp(M(end, :));      % last row → 1x3
disp(M(:, end));      % last col → 3x1
