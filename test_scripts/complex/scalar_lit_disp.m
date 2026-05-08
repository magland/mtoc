% Scalar complex literals exercise every branch of formatComplex:
%   im == 0     → real-format path
%   re == 0     → "<im>i"
%   im < 0      → "<re> - <|im|>i"
%   else        → "<re> + <im>i"
disp(1i);
disp(2.5i);
disp(3 + 4i);
disp(3 - 4i);
disp(3 + 0i);
disp(0 + 4i);
disp(-1 - 1.5i);
disp(2 + 0.5i);
