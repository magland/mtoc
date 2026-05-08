% Unary +/- on scalar complex values, including folded literal-targeted
% unaries (-1i, -(2+3i)) and the post-arith case (negating a complex
% variable).
disp(-1i);
disp(-2.5i);
disp(-(1 + 2i));
disp(+(3 - 4i));

a = 1 + 2i;
disp(-a);
disp(+a);

% Unary minus on a sum of complex
b = -(a + (3 - 1i));
disp(b);
