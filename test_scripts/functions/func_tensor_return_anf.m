% Compositions enabled by the post-lowering ANF pass: every
% owned-producing sub-expression (TensorLit, IndexSlice, string
% concat, user-func owned Call) is hoisted to its own synthetic
% Assign before validation/codegen, so arbitrary nesting works
% without per-case patchwork.

function y = helper(x)
  y = sqrt(x);
end

function y = bump(x, k)
  y = x + k;
end

x = [1 16 81 256];

% Nested user-function tensor calls (the originally-failing case).
y1 = helper(helper(x));
disp(y1);

% User-func tensor return inside another user-func call's args.
y2 = bump(helper(x), 10);
disp(y2);

% Reduction over a user-func tensor return.
s = sum(helper(x));
disp(s);

% Three levels of nesting.
y3 = helper(bump(helper(x), 0));
disp(y3);

% disp of a user-func tensor expression.
disp(helper(x));

% TensorLit nested in arithmetic — lifted by ANF.
y4 = [1 2 3 4] + 100;
disp(y4);

% IndexSlice nested in arithmetic — lifted by ANF.
y5 = x(2:4) + 1000;
disp(y5);

% Two IndexSlices in one expression.
y6 = x(1:2) .* x(3:4);
disp(y6);

% disp of an IndexSlice.
disp(x(2:3));

% Mixed: user-func tensor call with regular tensor operand.
v = [10 20 30 40];
y7 = helper(x) + v;
disp(y7);
