% A non-owned multi-element expression (Binary / Unary / elementwise
% Call on tensors) used as a value at a consume-as-struct site is
% auto-hoisted to a synthetic temp by the ANF pass; the consumer
% sees a Var. Covers disp / sum / user-function arg / fprintf arg.

a = [1 2 3];
b = [4 5 6];

% disp consumes a struct handle.
disp(a + b);
disp(a .* b);
disp(2 * a);
disp(sqrt(a));
disp(-a);

% Reduction over a tensor expression: numel/sum/min/max take a
% struct handle.
disp(numel(a + b));
disp(sum(a + b));
disp(min(a + b));
disp(max(a + b));

% User-function with a tensor parameter — args go through copy-on-
% arg-pass, which requires a struct handle.
function y = doubled(t)
    y = t .* 2;
end
disp(doubled(a + 1));
disp(sum(doubled(a + b)));

% fprintf value args route to the format engine; tensors are
% flattened. Same lift rule.
fprintf('%d ', a + b);
fprintf('\n');
fprintf('%g ', sqrt(a));
fprintf('\n');

% Nested: lift composes through multiple layers.
disp(sqrt(a + b));
disp(sum(sqrt(a + b)));
