% Broadcasting where one operand has a singleton row axis: a row
% vector broadcasts row-wise across a 2-D matrix.
M = [1 2 3; 4 5 6; 7 8 9];   % 3x3
r = [10 20 30];              % 1x3
S = M + r;                    % 3x3
disp(S);

% And the other direction (column vector + matrix).
c = [100; 200; 300];         % 3x1
T = M + c;                    % 3x3
disp(T);

% Mixed: subtract row vector from matrix.
D = M - r;
disp(D);
