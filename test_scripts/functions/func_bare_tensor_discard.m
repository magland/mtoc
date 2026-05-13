% Bare statement-scope owned-valued expressions: the result is bound
% to a synthetic discard, so the side effect runs and the heap buffer
% is freed at scope exit instead of leaking.

function y = double_it(x)
  disp(x);
  y = x * 2;
end

function s = greeting()
  disp("greet ran");
  s = "hello " + "world";
end

% 1-output user call returning a tensor — the disp inside fires; the
% caller drops the result.
double_it([4, 4, 5]);

% Same shape for a string-returning call.
greeting();

% Tensor literal at statement scope.
[1, 2, 3];

% Tensor-valued expression at statement scope.
[1, 2, 3] + [10, 20, 30];

% Confirm normal use still works after a discard.
y = double_it([1, 2, 3]);
disp(y);
