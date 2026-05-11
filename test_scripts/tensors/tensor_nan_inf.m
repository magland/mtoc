% nan() / NaN() / inf() / Inf() — N-D constructors filled with the
% respective IEEE special value.

disp(nan());              % NaN
disp(NaN());              % NaN
disp(inf());              % Inf
disp(Inf());              % Inf

A = nan(2, 3);
disp(A);                  % 2x3 NaN

B = inf(2);
disp(B);                  % 2x2 Inf

C = nan(2, 2, 2);
disp(size(C));            % [2 2 2]
disp(numel(C));           % 8
