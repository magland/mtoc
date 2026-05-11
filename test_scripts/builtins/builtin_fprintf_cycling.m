% Format-cycling and arg-underconsumption edge cases for fprintf.
% numbl's sprintfFormat repeats the format string until the arg
% stream is exhausted (or no progress is made on a pass).

% Cycling: 3 args, format has 1 spec → format runs 3 times.
fprintf('[%d]\n', 1, 2, 3);

% Two specs per pass over a 4-element vector.
v = [10 20 30 40];
fprintf('[%d,%d]\n', v);

% Mixing scalar + tensor in the value stream — the tensor flattens
% column-major into the scalar slot stream.
M = [1 2; 3 4];   % column-major: 1, 3, 2, 4
fprintf('%d ', M);
fprintf('\n');

% Format with no spec + args: numbl emits the format once and stops
% (the "no progress this pass" guard kicks in).
fprintf('plain\n', 99, 100);
