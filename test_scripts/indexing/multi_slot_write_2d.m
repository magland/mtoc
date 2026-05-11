% Multi-slot write into a 2-D tensor. Two RHS kinds:
%   - scalar broadcast: same value into every slot of the slice
%   - tensor RHS: copy slot-by-slot with a runtime count check
M = zeros(3, 3);
M(:, 2) = 9;      disp(M);        % column 2 → 9
M(2, :) = -1;     disp(M);        % row 2    → -1
M(:, :) = 5;      disp(M);        % full     → 5

% Tensor RHS — column vector into column slice.
v = [10; 20; 30];
M(:, 1) = v;      disp(M);

% Tensor RHS — row vector into row slice.
r = [100 200 300];
M(3, :) = r;      disp(M);

% Range slot + colon slot, scalar broadcast.
M(1:2, :) = 0;    disp(M);
